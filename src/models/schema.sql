-- ============================================================================
-- Real-Time Collaborative Task Board Schema (PostgreSQL 16)
-- Supports Optimistic Concurrency Control (OCC) and Fractional Indexing
-- ============================================================================

-- Boards: Workspace containers
CREATE TABLE IF NOT EXISTS boards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Columns: Vertical workflow stages (e.g., Todo, In Progress, Done)
-- Uses DECIMAL(18, 9) position for O(1) fractional ordering
CREATE TABLE IF NOT EXISTS columns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position DECIMAL(18, 9) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Tasks: Cards residing within a column
-- version column enables Database-Authoritative Optimistic Concurrency Control (OCC)
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    column_id UUID NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    position DECIMAL(18, 9) NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Users: Authentication & Authorization
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Board Members: Access control matrix
CREATE TABLE IF NOT EXISTS board_members (
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (board_id, user_id)
);

-- Board Events: Append-only event store for audit, replay & delta sync upon reconnect
CREATE TABLE IF NOT EXISTS board_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Optimized indexes for fast ordered column retrieval and board joins
CREATE INDEX IF NOT EXISTS idx_columns_board_position ON columns(board_id, position ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_column_position ON tasks(column_id, position ASC);
CREATE INDEX IF NOT EXISTS idx_board_members_user_id ON board_members(user_id);
CREATE INDEX IF NOT EXISTS idx_board_events_board_id ON board_events(board_id, created_at DESC);
