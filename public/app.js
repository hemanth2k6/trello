// Real-Time Collaborative Task Board Frontend
(() => {
  // Application State
  const state = {
    socket: null,
    currentBoardId: null,
    boards: [],
    boardData: null, // { board_id, board_title, columns: [...] }
    draggedTaskId: null,
    draggedFromColId: null,
  };

  // DOM Elements
  const el = {
    boardSelect: document.getElementById('board-select'),
    btnNewBoard: document.getElementById('btn-new-board'),
    btnAddColumn: document.getElementById('btn-add-column'),
    boardTitle: document.getElementById('board-title'),
    columnsContainer: document.getElementById('columns-container'),
    statusBadge: document.getElementById('connection-status'),
    modalBoard: document.getElementById('modal-board'),
    formCreateBoard: document.getElementById('form-create-board'),
    boardTitleInput: document.getElementById('board-title-input'),
    closeModalBoard: document.getElementById('close-modal-board'),
    cancelBoardBtn: document.getElementById('cancel-board-btn'),
    modalTask: document.getElementById('modal-task'),
    formEditTask: document.getElementById('form-edit-task'),
    editTaskId: document.getElementById('edit-task-id'),
    editTaskTitle: document.getElementById('edit-task-title'),
    editTaskDesc: document.getElementById('edit-task-desc'),
    editTaskMeta: document.getElementById('edit-task-meta'),
    closeModalTask: document.getElementById('close-modal-task'),
    cancelTaskBtn: document.getElementById('cancel-task-btn'),
    btnDeleteTask: document.getElementById('btn-delete-task'),
    toastContainer: document.getElementById('toast-container'),
  };

  // Toast Notifications
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    el.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // Socket.io Setup
  function initSocket() {
    state.socket = io({
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    state.socket.on('connect', () => {
      updateStatus('connected', 'Connected');
      if (state.currentBoardId) {
        state.socket.emit('join_board', state.currentBoardId);
      }
    });

    state.socket.on('disconnect', () => {
      updateStatus('disconnected', 'Disconnected');
    });

    state.socket.on('connect_error', () => {
      updateStatus('connecting', 'Reconnecting...');
    });

    // Real-Time Events
    state.socket.on('TASK_MOVED', (data) => {
      handleRemoteTaskMoved(data);
    });

    state.socket.on('TASK_MOVE_REJECTED', (data) => {
      handleTaskMoveRejected(data);
    });

    state.socket.on('TASK_CREATED', (data) => {
      handleRemoteTaskCreated(data);
    });

    state.socket.on('TASK_UPDATED', (data) => {
      handleRemoteTaskUpdated(data);
    });

    state.socket.on('TASK_DELETED', (data) => {
      handleRemoteTaskDeleted(data);
    });

    state.socket.on('COLUMN_CREATED', (data) => {
      if (data.boardId === state.currentBoardId) {
        state.boardData.columns.push(data.column);
        renderColumns();
      }
    });

    state.socket.on('COLUMN_UPDATED', (data) => {
      if (data.boardId === state.currentBoardId) {
        const col = state.boardData.columns.find((c) => c.id === data.column.id);
        if (col) {
          col.title = data.column.title;
          renderColumns();
        }
      }
    });

    state.socket.on('COLUMN_DELETED', (data) => {
      if (data.boardId === state.currentBoardId) {
        state.boardData.columns = state.boardData.columns.filter((c) => c.id !== data.columnId);
        renderColumns();
      }
    });
  }

  function updateStatus(status, text) {
    el.statusBadge.className = `status-badge ${status}`;
    el.statusBadge.querySelector('.status-text').textContent = text;
  }

  // Load Boards List
  async function loadBoardsList() {
    try {
      const res = await fetch('/api/boards');
      if (!res.ok) throw new Error('Failed to load boards');
      state.boards = await res.json();

      el.boardSelect.innerHTML = '';
      if (state.boards.length === 0) {
        el.boardSelect.innerHTML = '<option value="" disabled selected>No boards yet</option>';
        return;
      }

      state.boards.forEach((board) => {
        const option = document.createElement('option');
        option.value = board.id;
        option.textContent = board.title;
        el.boardSelect.appendChild(option);
      });

      // Default to first board or URL hash
      const hashId = window.location.hash.replace('#', '');
      const selectedId = state.boards.find((b) => b.id === hashId) ? hashId : state.boards[0].id;
      el.boardSelect.value = selectedId;
      selectBoard(selectedId);
    } catch (err) {
      console.error(err);
      showToast('Error loading boards', 'danger');
    }
  }

  // Switch Current Board
  async function selectBoard(boardId) {
    if (state.currentBoardId && state.socket) {
      state.socket.emit('leave_board', state.currentBoardId);
    }

    state.currentBoardId = boardId;
    window.location.hash = boardId;

    if (state.socket && state.socket.connected) {
      state.socket.emit('join_board', boardId);
    }

    try {
      const res = await fetch(`/api/boards/${boardId}`);
      if (!res.ok) throw new Error('Failed to load board details');
      state.boardData = await res.json();

      el.boardTitle.textContent = state.boardData.board_title;
      renderColumns();
    } catch (err) {
      console.error(err);
      showToast('Failed to load board details', 'danger');
    }
  }

  // Render Columns and Cards
  function renderColumns() {
    el.columnsContainer.innerHTML = '';

    if (!state.boardData || !state.boardData.columns) return;

    state.boardData.columns.sort((a, b) => Number(a.position) - Number(b.position));

    state.boardData.columns.forEach((column) => {
      const colEl = createColumnElement(column);
      el.columnsContainer.appendChild(colEl);
    });
  }

  function createColumnElement(column) {
    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.columnId = column.id;

    // Header
    const header = document.createElement('div');
    header.className = 'column-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'column-title-group';

    const title = document.createElement('span');
    title.className = 'column-title';
    title.textContent = column.title;

    const count = document.createElement('span');
    count.className = 'task-count';
    count.textContent = column.tasks ? column.tasks.length : 0;

    titleGroup.appendChild(title);
    titleGroup.appendChild(count);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete-col';
    deleteBtn.innerHTML = '&times;';
    deleteBtn.title = 'Delete Column';
    deleteBtn.addEventListener('click', () => deleteColumn(column.id));

    header.appendChild(titleGroup);
    header.appendChild(deleteBtn);
    colEl.appendChild(header);

    // Task List Container
    const tasksList = document.createElement('div');
    tasksList.className = 'tasks-list';
    tasksList.dataset.columnId = column.id;

    // Drag Over & Drop Events on Column
    tasksList.addEventListener('dragover', (e) => {
      e.preventDefault();
      colEl.classList.add('drag-over');
    });

    tasksList.addEventListener('dragleave', (e) => {
      if (!tasksList.contains(e.relatedTarget)) {
        colEl.classList.remove('drag-over');
      }
    });

    tasksList.addEventListener('drop', (e) => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      handleTaskDrop(e, column.id, tasksList);
    });

    if (column.tasks) {
      column.tasks.sort((a, b) => Number(a.position) - Number(b.position));
      column.tasks.forEach((task) => {
        const card = createTaskCard(task, column.id);
        tasksList.appendChild(card);
      });
    }

    colEl.appendChild(tasksList);

    // Footer: Add Task Button
    const footer = document.createElement('div');
    footer.className = 'column-footer';

    const btnAddTask = document.createElement('button');
    btnAddTask.className = 'btn-add-task';
    btnAddTask.textContent = '+ Add a card';

    const addForm = document.createElement('div');
    addForm.className = 'add-task-form hidden';
    addForm.innerHTML = `
      <textarea placeholder="Enter a title for this card..." rows="2"></textarea>
      <div class="add-task-actions">
        <button class="btn btn-primary btn-sm btn-submit-task">Add Card</button>
        <button class="btn btn-secondary btn-sm btn-cancel-task">Cancel</button>
      </div>
    `;

    btnAddTask.addEventListener('click', () => {
      btnAddTask.classList.add('hidden');
      addForm.classList.remove('hidden');
      const textarea = addForm.querySelector('textarea');
      textarea.focus();
    });

    const btnCancel = addForm.querySelector('.btn-cancel-task');
    btnCancel.addEventListener('click', () => {
      addForm.classList.add('hidden');
      btnAddTask.classList.remove('hidden');
      addForm.querySelector('textarea').value = '';
    });

    const btnSubmit = addForm.querySelector('.btn-submit-task');
    btnSubmit.addEventListener('click', async () => {
      const textarea = addForm.querySelector('textarea');
      const text = textarea.value.trim();
      if (!text) return;
      await createTask(column.id, text);
      textarea.value = '';
      addForm.classList.add('hidden');
      btnAddTask.classList.remove('hidden');
    });

    footer.appendChild(btnAddTask);
    footer.appendChild(addForm);
    colEl.appendChild(footer);

    return colEl;
  }

  function createTaskCard(task, columnId) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.draggable = true;
    card.dataset.taskId = task.id;
    card.dataset.columnId = columnId;
    card.dataset.version = task.version;
    card.dataset.position = task.position;

    const title = document.createElement('div');
    title.className = 'task-card-title';
    title.textContent = task.title;
    card.appendChild(title);

    if (task.description) {
      const desc = document.createElement('div');
      desc.className = 'task-card-desc';
      desc.textContent = task.description;
      card.appendChild(desc);
    }

    const footer = document.createElement('div');
    footer.className = 'task-card-footer';

    const versionPill = document.createElement('span');
    versionPill.className = 'version-pill';
    versionPill.textContent = `v${task.version}`;
    footer.appendChild(versionPill);

    card.appendChild(footer);

    // Card Drag Events
    card.addEventListener('dragstart', (e) => {
      state.draggedTaskId = task.id;
      state.draggedFromColId = columnId;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', task.id);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.column').forEach((c) => c.classList.remove('drag-over'));
    });

    // Click to Open Edit Modal
    card.addEventListener('click', (e) => {
      if (card.classList.contains('dragging')) return;
      openTaskModal(task, columnId);
    });

    return card;
  }

  // Handle Drag and Drop
  function handleTaskDrop(e, targetColumnId, tasksList) {
    const taskId = state.draggedTaskId;
    if (!taskId) return;

    // Find task in local state
    let sourceCol = null;
    let task = null;

    for (const col of state.boardData.columns) {
      const found = (col.tasks || []).find((t) => t.id === taskId);
      if (found) {
        sourceCol = col;
        task = found;
        break;
      }
    }

    if (!task) return;

    const currentVersion = task.version;
    const targetCol = state.boardData.columns.find((c) => c.id === targetColumnId);
    if (!targetCol) return;

    // Calculate new position based on drop coordinates
    const cards = Array.from(tasksList.querySelectorAll('.task-card:not(.dragging)'));
    let newPosition = 1000;

    if (cards.length === 0) {
      newPosition = 1000;
    } else {
      // Find insertion index
      const mouseY = e.clientY;
      let insertIndex = cards.length;

      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (mouseY < midY) {
          insertIndex = i;
          break;
        }
      }

      if (insertIndex === 0) {
        const firstPos = Number(cards[0].dataset.position || 1000);
        newPosition = Math.max(1, firstPos / 2);
      } else if (insertIndex >= cards.length) {
        const lastPos = Number(cards[cards.length - 1].dataset.position || 1000);
        newPosition = lastPos + 1000;
      } else {
        const prevPos = Number(cards[insertIndex - 1].dataset.position || 0);
        const nextPos = Number(cards[insertIndex].dataset.position || 2000);
        newPosition = (prevPos + nextPos) / 2;
      }
    }

    // Optimistic DOM Update
    sourceCol.tasks = sourceCol.tasks.filter((t) => t.id !== taskId);
    task.column_id = targetColumnId;
    task.position = newPosition;
    targetCol.tasks = targetCol.tasks || [];
    targetCol.tasks.push(task);

    renderColumns();

    // Emit TASK_MOVED over Socket.io
    state.socket.emit('TASK_MOVED', {
      boardId: state.currentBoardId,
      taskId: task.id,
      columnId: targetColumnId,
      position: newPosition,
      version: currentVersion,
    });
  }

  // Remote Event Handlers
  function handleRemoteTaskMoved(data) {
    if (data.boardId !== state.currentBoardId) return;

    // Find and update task
    let existingTask = null;
    state.boardData.columns.forEach((col) => {
      const idx = (col.tasks || []).findIndex((t) => t.id === data.id);
      if (idx !== -1) {
        existingTask = col.tasks.splice(idx, 1)[0];
      }
    });

    const targetCol = state.boardData.columns.find((c) => c.id === data.column_id);
    if (targetCol) {
      const updated = {
        ...(existingTask || {}),
        ...data,
      };
      targetCol.tasks = targetCol.tasks || [];
      targetCol.tasks.push(updated);
    }

    renderColumns();
  }

  function handleTaskMoveRejected(data) {
    showToast(`Conflict: ${data.message || 'Task version mismatch'}. Syncing with server...`, 'warning');

    if (data.latestTask) {
      // Revert task state to latest authoritative state
      handleRemoteTaskMoved({
        boardId: state.currentBoardId,
        ...data.latestTask,
      });
    } else {
      selectBoard(state.currentBoardId);
    }
  }

  function handleRemoteTaskCreated(task) {
    if (task.boardId !== state.currentBoardId) return;
    const col = state.boardData.columns.find((c) => c.id === task.column_id);
    if (col) {
      col.tasks = col.tasks || [];
      if (!col.tasks.some((t) => t.id === task.id)) {
        col.tasks.push(task);
        renderColumns();
      }
    }
  }

  function handleRemoteTaskUpdated(task) {
    if (task.boardId !== state.currentBoardId) return;
    for (const col of state.boardData.columns) {
      const t = (col.tasks || []).find((item) => item.id === task.id);
      if (t) {
        t.title = task.title;
        t.description = task.description;
        t.version = task.version;
        t.updated_at = task.updated_at;
        renderColumns();
        break;
      }
    }
  }

  function handleRemoteTaskDeleted(data) {
    if (data.boardId !== state.currentBoardId) return;
    for (const col of state.boardData.columns) {
      if (col.tasks) {
        col.tasks = col.tasks.filter((t) => t.id !== data.taskId);
      }
    }
    renderColumns();
  }

  // Create Task API
  async function createTask(columnId, title) {
    try {
      const res = await fetch(`/api/boards/${state.currentBoardId}/columns/${columnId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error('Failed to create task');
      const newTask = await res.json();
      handleRemoteTaskCreated({ ...newTask, boardId: state.currentBoardId });
    } catch (err) {
      console.error(err);
      showToast('Error creating card', 'danger');
    }
  }

  // Delete Column API
  async function deleteColumn(columnId) {
    if (!confirm('Are you sure you want to delete this column and all its cards?')) return;
    try {
      const res = await fetch(`/api/columns/${columnId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete column');
      state.boardData.columns = state.boardData.columns.filter((c) => c.id !== columnId);
      renderColumns();
      showToast('Column deleted', 'info');
    } catch (err) {
      console.error(err);
      showToast('Error deleting column', 'danger');
    }
  }

  // Task Details Modal
  function openTaskModal(task, columnId) {
    el.editTaskId.value = task.id;
    el.editTaskTitle.value = task.title;
    el.editTaskDesc.value = task.description || '';
    el.editTaskMeta.innerHTML = `
      <span>Version: <strong>v${task.version}</strong></span> &bull;
      <span>Updated: ${new Date(task.updated_at || task.created_at).toLocaleTimeString()}</span>
    `;
    el.modalTask.classList.remove('hidden');
  }

  function closeTaskModal() {
    el.modalTask.classList.add('hidden');
  }

  el.closeModalTask.addEventListener('click', closeTaskModal);
  el.cancelTaskBtn.addEventListener('click', closeTaskModal);

  el.formEditTask.addEventListener('submit', async (e) => {
    e.preventDefault();
    const taskId = el.editTaskId.value;
    const title = el.editTaskTitle.value.trim();
    const description = el.editTaskDesc.value.trim();

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description }),
      });
      if (!res.ok) throw new Error('Failed to update task');
      const updated = await res.json();
      handleRemoteTaskUpdated({ ...updated, boardId: state.currentBoardId });
      closeTaskModal();
      showToast('Card updated', 'success');
    } catch (err) {
      console.error(err);
      showToast('Error updating card', 'danger');
    }
  });

  el.btnDeleteTask.addEventListener('click', async () => {
    const taskId = el.editTaskId.value;
    if (!confirm('Are you sure you want to delete this card?')) return;

    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete task');
      handleRemoteTaskDeleted({ taskId, boardId: state.currentBoardId });
      closeTaskModal();
      showToast('Card deleted', 'info');
    } catch (err) {
      console.error(err);
      showToast('Error deleting card', 'danger');
    }
  });

  // Create Board Modal
  el.btnNewBoard.addEventListener('click', () => {
    el.modalBoard.classList.remove('hidden');
    el.boardTitleInput.focus();
  });

  function closeBoardModal() {
    el.modalBoard.classList.add('hidden');
    el.boardTitleInput.value = '';
  }

  el.closeModalBoard.addEventListener('click', closeBoardModal);
  el.cancelBoardBtn.addEventListener('click', closeBoardModal);

  el.formCreateBoard.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = el.boardTitleInput.value.trim();
    if (!title) return;

    try {
      const res = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error('Failed to create board');
      const newBoard = await res.json();
      closeBoardModal();
      await loadBoardsList();
      selectBoard(newBoard.id);
      showToast(`Board "${newBoard.title}" created`, 'success');
    } catch (err) {
      console.error(err);
      showToast('Error creating board', 'danger');
    }
  });

  // Add Column Button
  el.btnAddColumn.addEventListener('click', async () => {
    const title = prompt('Enter column title:');
    if (!title || !title.trim()) return;

    try {
      const res = await fetch(`/api/boards/${state.currentBoardId}/columns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      });
      if (!res.ok) throw new Error('Failed to create column');
      const col = await res.json();
      state.boardData.columns.push(col);
      renderColumns();
      showToast(`Column "${col.title}" added`, 'success');
    } catch (err) {
      console.error(err);
      showToast('Error adding column', 'danger');
    }
  });

  // Board Select Dropdown Change
  el.boardSelect.addEventListener('change', (e) => {
    selectBoard(e.target.value);
  });

  // Initialization
  initSocket();
  loadBoardsList();
})();
