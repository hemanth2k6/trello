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

### 1. Connection Authentication
Clients must authenticate when connecting by providing a JWT in the connection handshake.
- **Authentication**: `socket.handshake.auth.token` (or `Authorization: Bearer <token>` header)
- **Error Behavior**: Connections with missing or invalid tokens are immediately rejected with an `Authentication error` connect error.

### 2. `join_board`
Client joins a board's broadcast channel.
- **Direction**: Client $\to$ Server
- **Payload**: `boardId` (UUID string)
- **Membership Check**: The authenticated user must be a member or owner of the board in `board_members`. If not, an `error` / `join_board_error` event is emitted to the socket and the room is not joined.
- **Initial Presence Sync**: Server emits the current online user list directly to the joining socket (`online_users` / `presence_current`).
- **Presence Broadcast**: Server broadcasts a `presence_update` to the room announcing the new user.

### 3. `leave_board`
Client leaves a board's broadcast channel.
- **Direction**: Client $\to$ Server
- **Payload**: `boardId` (UUID string)
- **Presence Broadcast**: Server removes the user from the Redis presence sorted set and broadcasts `presence_update` (`action: "leave"`).

### 4. `heartbeat`
Client sends periodic heartbeats (every 30 seconds) while active on a board.
- **Direction**: Client $\to$ Server
- **Payload**: `{ "boardId": "c3789a74-d47f-47ea-a2f0-7b56191f63a1" }` (or boardId string)
- **Server Behavior**: Updates the member's score in Redis sorted set `presence:{boardId}` to the current timestamp.

### 5. `presence_update` (Broadcast)
Broadcasted to the board room when a user joins or leaves.
- **Direction**: Server $\to$ Room (`board:{boardId}`)
- **Payload**:
  ```json
  {
    "boardId": "c3789a74-d47f-47ea-a2f0-7b56191f63a1",
    "users": [
      "d9c386f0-a7d8-4889-93ee-5f72578b4c67",
      "2a47fa61-c906-4ed7-8d09-1892476bac76"
    ],
    "userId": "2a47fa61-c906-4ed7-8d09-1892476bac76",
    "action": "join"
  }
  ```

### 6. `TASK_MOVED`
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

### 7. `TASK_MOVED` (Broadcast)
Broadcasted to all clients in `board:{boardId}` room after successful persistence. Also records an entry in `board_events`.
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
    "updated_at": "2026-10-31T06:12:46.416Z",
    "moved_by": "d9c386f0-a7d8-4889-93ee-5f72578b4c67"
  }
  ```

### 8. `TASK_MOVE_REJECTED`
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

## 5. Architectural Note: Why Event Logs Are Separate From Real-Time Broadcasts

A key design choice in this architecture is the deliberate separation between **real-time WebSocket broadcasts** and the **durable `board_events` activity log**.

1. **Ephemeral vs. Durable Delivery**:
   - **Real-Time Broadcasts**: Designed for zero-latency in-memory fan-out via Redis Pub/Sub directly to active WebSocket sessions. If a user is offline, experiencing network stutter, or navigating pages, in-flight WebSocket packets are dropped.
   - **Event Log (`board_events`)**: Stored durably in PostgreSQL with JSONB payloads, actor IDs, and immutable timestamps. It serves as an authoritative source of truth regardless of whether any client was connected at the instant of the event.

2. **Audit Trails & Activity Feeds**:
   - Business requirements (such as auditing, activity streams, compliance, and user accountability) demand historical querying and pagination (`GET /api/boards/:boardId/events?limit=50`). Broadcast channels cannot support historical querying without overloading the transient Pub/Sub tier.

3. **Offline Catch-Up & Reconnection Synchronization**:
   - When a client reconnects after an outage, fetching recent board events allows it to compute delta changes or display activity summaries without requiring a full re-render of the entire database state.

4. **Decoupled Performance**:
   - Persisting an event log entry in PostgreSQL runs as part of the write pipeline. Decoupling it from Socket.io broadcast dispatch ensures that client UI synchronization remains instantaneous and fire-and-forget, while event logging provides durability without slowing down the real-time event loop.

---

## 6. REST API Reference

### Authentication

#### Register User
```http
POST /api/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
```
**Response (`201 Created`)**:
```json
{
  "token": "<jwt-token>",
  "user": {
    "id": "d9c386f0-a7d8-4889-93ee-5f72578b4c67",
    "email": "user@example.com",
    "created_at": "2026-10-31T17:00:00.000Z"
  }
}
```

#### Login User
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
```
**Response (`200 OK`)**:
```json
{
  "token": "<jwt-token>",
  "user": {
    "id": "d9c386f0-a7d8-4889-93ee-5f72578b4c67",
    "email": "user@example.com",
    "created_at": "2026-10-31T17:00:00.000Z"
  }
}
```

---

### Boards & Membership

#### Get Board State (Protected, Board Members Only)
```http
GET /api/boards/:boardId
Authorization: Bearer <jwt-token>
```
- Returns 401 if unauthenticated.
- Returns 403 if authenticated user is not a board member.
- Returns 200 with aggregated board state if authorized.

#### Add Board Member
```http
POST /api/boards/:boardId/members
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "userId": "2a47fa61-c906-4ed7-8d09-1892476bac76",
  "role": "member"
}
```

#### Get Board Activity Events (Protected, Board Members Only)
```http
GET /api/boards/:boardId/events?limit=50
Authorization: Bearer <jwt-token>
```
Returns the most recent events for the board ordered by `created_at DESC`.

**Response (`200 OK`)**:
```json
[
  {
    "id": "b3e34bca-901a-4bc4-9382-720ad901a141",
    "board_id": "c3789a74-d47f-47ea-a2f0-7b56191f63a1",
    "event_type": "TASK_MOVED",
    "payload": {
      "boardId": "c3789a74-d47f-47ea-a2f0-7b56191f63a1",
      "id": "79bf0806-4484-4658-8be1-5f8732b89eb6",
      "column_id": "fc5d57a5-2453-4927-8fc3-4888dcebd4d6",
      "position": 2500,
      "version": 1,
      "moved_by": "d9c386f0-a7d8-4889-93ee-5f72578b4c67"
    },
    "actor_user_id": "d9c386f0-a7d8-4889-93ee-5f72578b4c67",
    "created_at": "2026-10-31T17:15:00.000Z"
  }
]
```

---

## 7. How to Run & Deploy (Free Tier)

### Free-Tier Deployment (Render + Upstash)

This repository includes a ready-to-deploy [`render.yaml`](render.yaml) Blueprint configuration:

1. **Create Free Redis on Upstash**:
   - Sign in at [console.upstash.com](https://console.upstash.com) with GitHub.
   - Click **Create Database**, name it `trello-redis`, and choose a primary region.
   - In the database dashboard, copy the `rediss://...` connection string.

2. **Deploy on Render via Blueprint**:
   - Sign in at [dashboard.render.com](https://dashboard.render.com) with GitHub.
   - Click **New +** $\to$ **Blueprint**.
   - Select your `trello` repository.
   - Render automatically provisions:
     - `trello-db` (Free PostgreSQL instance)
     - `trello-realtime-api` (Free Node.js Web Service)
   - When prompted for `REDIS_URL`, paste your Upstash connection string (`rediss://...`).
   - Click **Apply**.
   - The app automatically creates the database schema on first boot and serves the interactive frontend at your Render URL!

---

### Local Development Startup

#### Option 1: Docker Compose (All Services)
```bash
docker compose up --build
```

#### Option 2: Running Locally
1. **Install Dependencies**:
   ```bash
   npm install
   ```
2. **Configure Environment (`.env`)**:
   ```env
   PORT=3000
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/trello
   REDIS_URL=redis://localhost:6379
   JWT_SECRET=super-secret-task-board-jwt-key
   ```
3. **Start Application**:
   ```bash
   npm start
   ```

---

## 8. Testing

Run all automated test suites covering JWT authentication, board membership authorization, OCC collision handling, event logs, and Redis presence:

```bash
# Run all acceptance tests
npm test

# Run individual acceptance tests:
node test/feature1.test.js  # Feature 1: JWT Auth & Board Membership
node test/feature2.test.js  # Feature 2: Event Log & Activity API
node test/feature3.test.js  # Feature 3: Online Presence in Redis
node test/phase3.test.js    # Multi-client WebSocket broadcast
node test/phase4.test.js    # Concurrency control conflict rejection
node test/e2e.test.js       # End-to-end integration test
```
