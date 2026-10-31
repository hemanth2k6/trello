# Real-Time Collaborative Task Board (Trello Clone)

A production-grade, horizontally scalable real-time collaborative task board built with **Node.js (Express)**, **Socket.io**, **Redis Pub/Sub**, **PostgreSQL**, and **Docker**.

---

## 1. System Architecture

```text
                              ┌───────────────────────────────────┐
                              │     Client Browsers / Apps        │
                              └─────────────────┬─────────────────┘
                                                │
                        WebSocket / HTTP        │       WebSocket / HTTP
                        (Sticky / Round Robin)  │
                                                ▼
                         ┌──────────────────────────────────────┐
                         │           Load Balancer              │
                         └───────┬──────────────────────┬───────┘
                                 │                      │
                   ┌─────────────┴──────────┐   ┌───────┴──────────────┐
                   │  Node.js API Instance  │   │ Node.js API Instance │
                   │       (Server 1)       │   │      (Server 2)      │
                   └──────┬──────────────┬──┘   └──┬─────────────┬─────┘
                          │              │         │             │
        SQL (Pool Client) │              └───┐ ┌───┘             │ SQL (Pool Client)
                          ▼                  ▼ ▼                 ▼
             ┌──────────────────────┐   ┌───────────────────────────┐
             │      PostgreSQL      │   │       Redis Pub/Sub       │
             │  - Boards / Columns  │   │  @socket.io/redis-adapter │
             │  - Tasks (versioned) │   │ (Cross-Server Event Mesh) │
             └──────────────────────┘   └───────────────────────────┘
```

### Key Architectural Characteristics
- **Multi-Server WebSocket Sync**: Employs `@socket.io/redis-adapter` with dedicated pub/sub clients to distribute real-time events across any number of stateless Node.js server instances.
- **Room-Based Isolation**: Clients subscribe to isolated board channels via `board:{boardId}` rooms.
- **Atomic Optimistic Concurrency Control (OCC)**: Zero distributed locks. Concurrency is handled cleanly at the database row level using monotonic integer versioning.
- **Non-Blocking Real-Time Pipeline**: Database mutations are awaited to verify optimistic lock conditions, but Socket.io broadcast dispatch is non-blocking fire-and-forget. Broadcast logic is never coupled inside an open database transaction.
- **Single-Query Aggregation**: Full board state, including child columns and child tasks, is loaded in a single database round-trip via PostgreSQL JSON aggregation (`json_agg` + `json_build_object`).

---

## 2. Why Redis Pub/Sub?

When scaling Node.js WebSocket applications horizontally across multiple processes or container replicas:
1. Sockets connected to **Server A** cannot directly emit events to sockets connected to **Server B**.
2. Redis Pub/Sub serves as a low-latency shared message bus. Using `@socket.io/redis-adapter` with `createAdapter(pubClient, subClient)`:
   - When a client on Server A moves a card and calls `io.to("board:...").emit(...)`, Server A publishes the event packet to Redis.
   - All other API instances (Server B, Server C, etc.) subscribed to the adapter channel receive the packet and forward it down their local WebSocket connections to matching room members.
3. Redis adapter fan-out operates entirely in memory with sub-millisecond overhead, enabling horizontal scaling without sticky session restrictions or central socket bottlenecks.

---

## 3. Optimistic Concurrency Control (OCC)

In collaborative task boards, multiple users frequently attempt to reorder or drag cards at the same instant.

### Schema Design
Each task in PostgreSQL maintains a monotonic `version` integer:

```sql
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    column_id UUID NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    position DECIMAL(18, 9) NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

### The Mutation Protocol
When a client moves a task, it sends the task ID, target column ID, target position, and the version number it currently holds (`clientVersion`).

The persistence engine executes:
```sql
BEGIN;
UPDATE tasks
SET column_id = COALESCE($1, column_id),
    position = $2,
    version = version + 1,
    updated_at = now()
WHERE id = $3 AND version = $4
RETURNING id, column_id, title, description, position, version, created_at, updated_at;
```

- **Happy Path (`rowCount === 1`)**:
  - The transaction commits.
  - The server fires `io.to("board:...").emit("TASK_MOVED", ...)` to announce the move and new version (`version + 1`) to all connected users on that board.
- **Conflict Path (`rowCount === 0`)**:
  - Another client committed a change first, incrementing the database version.
  - The transaction issues `ROLLBACK` immediately.
  - The server emits `TASK_MOVE_REJECTED` **only to the originating socket** with the current state of the task (`latestTask`).
  - The rejected client snaps the card back to its correct authoritative position without disrupting other users.

---

## 4. Real-Time Event Contracts

### 1. `join_board`
Client joins a board's broadcast channel.
- **Direction**: Client $\to$ Server
- **Payload**: `boardId` (UUID string)

### 2. `leave_board`
Client leaves a board's broadcast channel.
- **Direction**: Client $\to$ Server
- **Payload**: `boardId` (UUID string)

### 3. `TASK_MOVED`
Client requests a task position or column update.
- **Direction**: Client $\to$ Server
- **Payload**:
  ```json
  {
    "boardId": "c3789a74-d47f-47ea-a2f0-7b56191f63a1",
    "taskId": "79bf0806-4484-4658-8be1-5f8732b89eb6",
    "columnId": "fc5d57a5-2453-4927-8fc3-4888dcebd4d6",
    "position": 2500,
    "version": 0
  }
  ```

### 4. `TASK_MOVED` (Broadcast)
Broadcasted to all clients in `board:{boardId}` room after successful persistence.
- **Direction**: Server $\to$ Room (`board:{boardId}`)
- **Payload**:
  ```json
  {
    "boardId": "c3789a74-d47f-47ea-a2f0-7b56191f63a1",
    "id": "79bf0806-4484-4658-8be1-5f8732b89eb6",
    "column_id": "fc5d57a5-2453-4927-8fc3-4888dcebd4d6",
    "title": "Setup Auth",
    "description": "Implement JWT",
    "position": 2500,
    "version": 1,
    "updated_at": "2026-10-31T06:12:46.416Z"
  }
  ```

### 5. `TASK_MOVE_REJECTED`
Sent **only** to the socket that initiated an out-of-date mutation.
- **Direction**: Server $\to$ Originating Socket
- **Payload**:
  ```json
  {
    "taskId": "79bf0806-4484-4658-8be1-5f8732b89eb6",
    "message": "Conflict: Task version mismatch",
    "clientVersion": 0,
    "latestTask": {
      "id": "79bf0806-4484-4658-8be1-5f8732b89eb6",
      "column_id": "bbf00ce6-fd46-4643-b2de-262c2e2d76de",
      "title": "Setup Auth",
      "description": "Implement JWT",
      "position": "1500.000000000",
      "version": 1,
      "updated_at": "2026-10-31T06:12:46.416Z"
    }
  }
  ```

---

## 5. REST API Reference

### Initial Board State Aggregation
```http
GET /api/boards/:boardId
```
Fetches the entire board, including nested columns and tasks, in a single SQL query using `json_agg` / `json_build_object`.

#### Response: `200 OK`
```json
{
  "board_id": "43a2cf95-5ac0-4081-b042-f397b55429d8",
  "board_title": "Sprint Board",
  "columns": [
    {
      "id": "62d359c7-178f-4a22-8359-f353955ead7a",
      "title": "To Do",
      "position": 1000,
      "tasks": [
        {
          "id": "79bf0806-4484-4658-8be1-5f8732b89eb6",
          "title": "Setup Auth",
          "description": "Implement JWT",
          "position": 1000,
          "version": 0,
          "created_at": "2026-10-31T06:05:22.687Z",
          "updated_at": "2026-10-31T06:05:22.687Z"
        }
      ]
    },
    {
      "id": "fc5d57a5-2453-4927-8fc3-4888dcebd4d6",
      "title": "Done",
      "position": 2000,
      "tasks": []
    }
  ]
}
```

### Create Board
```http
POST /api/boards
Content-Type: application/json

{
  "title": "Sprint Board"
}
```

### Health Check
```http
GET /health
```

---

## 6. How to Run

### Option 1: One-Command Startup with Docker Compose
To build and spin up the complete infrastructure (PostgreSQL 16, Redis 7, Node.js API):

```bash
docker compose up --build
```

To run multiple API instances with Docker Compose port allocation:
```bash
docker compose up --build --scale api=3
```

### Option 2: Running Locally for Development

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment (`.env`)**:
   ```env
   PORT=3000
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/trello
   REDIS_URL=redis://localhost:6379
   ```

3. **Initialize Database Schema**:
   ```bash
   psql -U postgres -d trello -f src/models/schema.sql
   ```

4. **Start Application**:
   ```bash
   npm start
   ```

---

## 7. Testing

Automated phase test suites test the critical architectural contracts:

```bash
# Test WebSocket cross-client broadcast over Redis adapter
node test/phase3.test.js

# Test concurrent task move optimistic lock collision handling
node test/phase4.test.js
```
