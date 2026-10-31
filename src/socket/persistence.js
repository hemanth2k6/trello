/**
 * Persists task movement to the database with optimistic concurrency.
 * In Phase 3, this provides a functional pass-through;
 * Phase 4 implements the full PostgreSQL transaction with row-level version checking.
 */
async function persistTaskMove({ taskId, columnId, position, version }) {
  return {
    taskId,
    columnId,
    position,
    version: (version ?? 0) + 1,
  };
}

module.exports = {
  persistTaskMove,
};
