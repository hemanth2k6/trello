// Real-Time Collaborative Task Board Frontend
(() => {
  // Application State
  const state = {
    socket: null,
    token: localStorage.getItem('token') || null,
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    currentBoardId: null,
    boards: [],
    boardData: null, // { board_id, board_title, columns: [...] }
    draggedTaskId: null,
    draggedFromColId: null,
    authMode: 'login', // 'login' | 'register'
    onlineUsers: new Set(),
  };

  // DOM Elements
  const el = {
    boardSelect: document.getElementById('board-select'),
    btnNewBoard: document.getElementById('btn-new-board'),
    btnAddColumn: document.getElementById('btn-add-column'),
    btnInviteMember: document.getElementById('btn-invite-member'),
    boardTitle: document.getElementById('board-title'),
    columnsContainer: document.getElementById('columns-container'),
    statusBadge: document.getElementById('connection-status'),
    presenceBadge: document.getElementById('presence-badge'),
    presenceCount: document.getElementById('presence-count'),
    userDisplay: document.getElementById('user-display'),
    btnAuthToggle: document.getElementById('btn-auth-toggle'),
    // Modals
    modalAuth: document.getElementById('modal-auth'),
    authModalTitle: document.getElementById('auth-modal-title'),
    formAuth: document.getElementById('form-auth'),
    authEmail: document.getElementById('auth-email'),
    authPassword: document.getElementById('auth-password'),
    btnAuthSubmit: document.getElementById('btn-auth-submit'),
    tabLogin: document.getElementById('tab-login'),
    tabRegister: document.getElementById('tab-register'),
    btnQuickDemoLogin: document.getElementById('btn-quick-demo-login'),
    closeModalAuth: document.getElementById('close-modal-auth'),
    // Board Modal
    modalBoard: document.getElementById('modal-board'),
    formCreateBoard: document.getElementById('form-create-board'),
    boardTitleInput: document.getElementById('board-title-input'),
    closeModalBoard: document.getElementById('close-modal-board'),
    cancelBoardBtn: document.getElementById('cancel-board-btn'),
    // Invite Modal
    modalInvite: document.getElementById('modal-invite'),
    formInviteMember: document.getElementById('form-invite-member'),
    inviteEmail: document.getElementById('invite-email'),
    closeModalInvite: document.getElementById('close-modal-invite'),
    cancelInviteBtn: document.getElementById('cancel-invite-btn'),
    // Task Modal
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

  // Unified API Fetch helper with Auth Header
  async function apiFetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    };

    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      updateStatus('disconnected', 'Unauthorized');
      showToast('Session expired. Please sign in.', 'warning');
      logoutUser();
      openAuthModal();
      throw new Error('Unauthorized');
    }
    return res;
  }

  // Status Badge Updater
  function updateStatus(status, text) {
    el.statusBadge.className = `status-badge ${status}`;
    el.statusBadge.querySelector('.status-text').textContent = text;
  }

  // Update User UI
  function updateUserUI() {
    if (state.token && state.user) {
      el.userDisplay.textContent = state.user.email;
      el.userDisplay.title = `Signed in as ${state.user.email}`;
      el.btnAuthToggle.textContent = 'Sign Out';
    } else {
      el.userDisplay.textContent = 'Guest';
      el.userDisplay.title = 'Not signed in';
      el.btnAuthToggle.textContent = 'Sign In';
    }
  }

  // Update Presence Badge
  function updatePresenceUI(count) {
    const online = count || state.onlineUsers.size || 1;
    el.presenceCount.textContent = `${online} online`;
  }

  // Socket.io Setup
  function initSocket() {
    if (!state.token) {
      updateStatus('disconnected', 'Sign in required');
      return;
    }

    if (state.socket) {
      state.socket.disconnect();
    }

    updateStatus('connecting', 'Connecting...');

    state.socket = io({
      auth: { token: state.token },
      reconnectionAttempts: 15,
      reconnectionDelay: 1000,
      transports: ['websocket', 'polling'],
    });

    state.socket.on('connect', () => {
      updateStatus('connected', 'Connected');
      if (state.currentBoardId) {
        state.socket.emit('join_board', state.currentBoardId);
      }
    });

    // Send heartbeat every 30s to maintain presence timestamp in Redis
    setInterval(() => {
      if (state.socket && state.socket.connected && state.currentBoardId) {
        state.socket.emit('heartbeat', { boardId: state.currentBoardId });
      }
    }, 30000);

    state.socket.on('disconnect', (reason) => {
      updateStatus('disconnected', 'Disconnected');
    });

    state.socket.on('connect_error', (err) => {
      console.warn('Socket connect_error:', err.message);
      if (err.message && err.message.includes('Authentication error')) {
        updateStatus('disconnected', 'Auth Error');
        logoutUser();
        openAuthModal();
      } else {
        updateStatus('connecting', 'Reconnecting...');
      }
    });

    // Presence Events
    state.socket.on('online_users', (data) => {
      if (data && data.boardId === state.currentBoardId && Array.isArray(data.users)) {
        state.onlineUsers = new Set(data.users);
        updatePresenceUI(state.onlineUsers.size);
      }
    });

    state.socket.on('presence_current', (data) => {
      if (data && data.boardId === state.currentBoardId && Array.isArray(data.users)) {
        state.onlineUsers = new Set(data.users);
        updatePresenceUI(state.onlineUsers.size);
      }
    });

    state.socket.on('presence_update', (data) => {
      if (data && data.boardId === state.currentBoardId) {
        if (Array.isArray(data.users)) {
          state.onlineUsers = new Set(data.users);
        } else if (data.action === 'join' && data.userId) {
          state.onlineUsers.add(data.userId);
        } else if (data.action === 'leave' && data.userId) {
          state.onlineUsers.delete(data.userId);
        }
        updatePresenceUI(state.onlineUsers.size);
      }
    });

    // Real-Time Task & Column Events
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
      if (data.boardId === state.currentBoardId && state.boardData) {
        state.boardData.columns.push(data.column);
        renderColumns();
      }
    });

    state.socket.on('COLUMN_UPDATED', (data) => {
      if (data.boardId === state.currentBoardId && state.boardData) {
        const col = state.boardData.columns.find((c) => c.id === data.column.id);
        if (col) {
          col.title = data.column.title;
          renderColumns();
        }
      }
    });

    state.socket.on('COLUMN_DELETED', (data) => {
      if (data.boardId === state.currentBoardId && state.boardData) {
        state.boardData.columns = state.boardData.columns.filter((c) => c.id !== data.columnId);
        renderColumns();
      }
    });
  }

  // Load Boards List (User's Boards)
  async function loadBoardsList() {
    if (!state.token) {
      openAuthModal();
      return;
    }

    try {
      const res = await apiFetch('/api/boards');
      if (!res.ok) throw new Error('Failed to load boards');
      state.boards = await res.json();

      el.boardSelect.innerHTML = '';
      if (state.boards.length === 0) {
        // Automatically create a starter board for new users
        await autoCreateStarterBoard();
        return;
      }

      state.boards.forEach((board) => {
        const option = document.createElement('option');
        option.value = board.id;
        option.textContent = board.title;
        el.boardSelect.appendChild(option);
      });

      // Default to URL hash or first board
      const hashId = window.location.hash.replace('#', '');
      const selectedId = state.boards.find((b) => b.id === hashId) ? hashId : state.boards[0].id;
      el.boardSelect.value = selectedId;
      await selectBoard(selectedId);
    } catch (err) {
      console.error('Error loading boards:', err);
    }
  }

  // Auto-create starter board for first-time users
  async function autoCreateStarterBoard() {
    try {
      const res = await apiFetch('/api/boards', {
        method: 'POST',
        body: JSON.stringify({ title: 'Welcome Project Board' }),
      });
      if (res.ok) {
        const newBoard = await res.json();
        // Add sample starter tasks
        const boardDetailRes = await apiFetch(`/api/boards/${newBoard.id}`);
        const boardData = await boardDetailRes.json();
        if (boardData && boardData.columns && boardData.columns.length > 0) {
          const col1 = boardData.columns[0];
          await apiFetch(`/api/boards/${newBoard.id}/columns/${col1.id}/tasks`, {
            method: 'POST',
            body: JSON.stringify({
              title: 'Welcome to CollabBoard! 🚀',
              description: 'Drag and drop cards across columns in real-time. Share the board link to collaborate!',
            }),
          });
        }
        await loadBoardsList();
      }
    } catch (err) {
      console.error('Failed to create starter board:', err);
    }
  }

  // Switch Current Board
  async function selectBoard(boardId) {
    if (!boardId) return;

    if (state.currentBoardId && state.socket && state.socket.connected) {
      state.socket.emit('leave_board', state.currentBoardId);
    }

    state.currentBoardId = boardId;
    window.location.hash = boardId;

    if (state.socket && state.socket.connected) {
      state.socket.emit('join_board', boardId);
    }

    try {
      const res = await apiFetch(`/api/boards/${boardId}`);
      if (!res.ok) {
        if (res.status === 403) {
          showToast('You are not a member of this board.', 'danger');
        } else {
          showToast('Failed to load board details', 'danger');
        }
        return;
      }
      state.boardData = await res.json();
      el.boardTitle.textContent = state.boardData.board_title;
      renderColumns();
    } catch (err) {
      console.error('selectBoard error:', err);
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
      handleDropOnColumn(e, column.id);
    });

    // Render Cards inside column
    const tasks = column.tasks || [];
    tasks.sort((a, b) => Number(a.position) - Number(b.position));

    tasks.forEach((task) => {
      const card = createTaskCard(task, column.id);
      tasksList.appendChild(card);
    });

    colEl.appendChild(tasksList);

    // Add Task Footer Button
    const footer = document.createElement('div');
    footer.className = 'column-footer';

    const btnAddTask = document.createElement('button');
    btnAddTask.className = 'btn-add-task';
    btnAddTask.innerHTML = '<span>+</span> Add card';
    btnAddTask.addEventListener('click', () => showQuickTaskInput(column.id, footer));

    footer.appendChild(btnAddTask);
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

    const titleEl = document.createElement('div');
    titleEl.className = 'task-title';
    titleEl.textContent = task.title;
    card.appendChild(titleEl);

    if (task.description) {
      const descEl = document.createElement('div');
      descEl.className = 'task-desc-preview';
      descEl.textContent = task.description;
      card.appendChild(descEl);
    }

    const metaEl = document.createElement('div');
    metaEl.className = 'task-meta';
    metaEl.innerHTML = `<span class="task-ver-badge">v${task.version}</span>`;
    card.appendChild(metaEl);

    // Click to Open Edit Modal
    card.addEventListener('click', (e) => {
      if (card.classList.contains('dragging')) return;
      openTaskModal(task);
    });

    // Drag Events
    card.addEventListener('dragstart', (e) => {
      state.draggedTaskId = task.id;
      state.draggedFromColId = columnId;
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', task.id);
      e.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.column').forEach((col) => col.classList.remove('drag-over'));
      document.querySelectorAll('.task-card').forEach((c) => c.classList.remove('drag-over-card'));
    });

    return card;
  }

  // Quick Task Creation Input in Column Footer
  function showQuickTaskInput(columnId, footer) {
    footer.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'quick-task-wrapper';

    const input = document.createElement('textarea');
    input.className = 'quick-task-input';
    input.placeholder = 'Enter a title for this card...';
    input.rows = 2;

    const actions = document.createElement('div');
    actions.className = 'quick-task-actions';

    const btnSubmit = document.createElement('button');
    btnSubmit.className = 'btn btn-primary btn-sm';
    btnSubmit.textContent = 'Add Card';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn btn-secondary btn-sm';
    btnCancel.textContent = 'Cancel';

    actions.appendChild(btnSubmit);
    actions.appendChild(btnCancel);
    wrapper.appendChild(input);
    wrapper.appendChild(actions);
    footer.appendChild(wrapper);

    input.focus();

    async function submitTask() {
      const title = input.value.trim();
      if (!title) return;

      try {
        const res = await apiFetch(`/api/boards/${state.currentBoardId}/columns/${columnId}/tasks`, {
          method: 'POST',
          body: JSON.stringify({ title }),
        });
        if (!res.ok) throw new Error('Failed to create task');
        const task = await res.json();

        // Optimistically add to state
        const col = state.boardData.columns.find((c) => c.id === columnId);
        if (col && !col.tasks.some((t) => t.id === task.id)) {
          col.tasks.push(task);
          renderColumns();
        }
      } catch (err) {
        showToast('Error creating task', 'danger');
      }
    }

    btnSubmit.addEventListener('click', submitTask);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitTask();
      } else if (e.key === 'Escape') {
        renderColumns();
      }
    });

    btnCancel.addEventListener('click', () => {
      renderColumns();
    });
  }

  // Handle Drag-and-Drop Mutation with Optimistic Concurrency Control (OCC)
  function handleDropOnColumn(e, targetColId) {
    const taskId = state.draggedTaskId;
    if (!taskId) return;

    const sourceCol = state.boardData.columns.find((c) =>
      c.tasks.some((t) => t.id === taskId)
    );
    if (!sourceCol) return;

    const task = sourceCol.tasks.find((t) => t.id === taskId);
    if (!task) return;

    const targetCol = state.boardData.columns.find((c) => c.id === targetColId);
    if (!targetCol) return;

    // Calculate new position
    const targetCards = targetCol.tasks.filter((t) => t.id !== taskId);
    targetCards.sort((a, b) => Number(a.position) - Number(b.position));

    let newPosition = 1000;
    if (targetCards.length > 0) {
      const lastTask = targetCards[targetCards.length - 1];
      newPosition = Number(lastTask.position) + 1000;
    }

    // Save previous state for rollback on conflict
    const previousColumnId = task.column_id;
    const previousPosition = task.position;
    const previousVersion = task.version;

    // Optimistically update local state immediately for 0ms UI lag
    sourceCol.tasks = sourceCol.tasks.filter((t) => t.id !== taskId);
    task.column_id = targetColId;
    task.position = newPosition;
    task.version = previousVersion + 1;
    targetCol.tasks.push(task);
    renderColumns();

    // Emit atomic OCC TASK_MOVED over WebSocket
    if (state.socket && state.socket.connected) {
      state.socket.emit('TASK_MOVED', {
        boardId: state.currentBoardId,
        taskId: task.id,
        columnId: targetColId,
        position: newPosition,
        version: previousVersion, // Must match DB current version
      });
    }
  }

  // Remote Event Handlers
  function handleRemoteTaskMoved(data) {
    if (!state.boardData || data.boardId !== state.currentBoardId) return;

    state.boardData.columns.forEach((col) => {
      col.tasks = col.tasks.filter((t) => t.id !== data.id);
    });

    const targetCol = state.boardData.columns.find((c) => c.id === data.column_id);
    if (targetCol) {
      targetCol.tasks.push({
        id: data.id,
        column_id: data.column_id,
        title: data.title,
        description: data.description,
        position: data.position,
        version: data.version,
        updated_at: data.updated_at,
      });
      renderColumns();
    }
  }

  function handleTaskMoveRejected(data) {
    showToast('Card position conflict detected. Synced with server.', 'warning');
    if (!state.boardData || !data.latestTask) return;

    const latest = data.latestTask;
    state.boardData.columns.forEach((col) => {
      col.tasks = col.tasks.filter((t) => t.id !== latest.id);
    });

    const targetCol = state.boardData.columns.find((c) => c.id === latest.column_id);
    if (targetCol) {
      targetCol.tasks.push(latest);
      renderColumns();
    }
  }

  function handleRemoteTaskCreated(data) {
    if (!state.boardData || data.boardId !== state.currentBoardId) return;

    const col = state.boardData.columns.find((c) => c.id === data.column_id);
    if (col && !col.tasks.some((t) => t.id === data.id)) {
      col.tasks.push({
        id: data.id,
        column_id: data.column_id,
        title: data.title,
        description: data.description,
        position: data.position,
        version: data.version,
      });
      renderColumns();
    }
  }

  function handleRemoteTaskUpdated(data) {
    if (!state.boardData || data.boardId !== state.currentBoardId) return;

    state.boardData.columns.forEach((col) => {
      const task = col.tasks.find((t) => t.id === data.id);
      if (task) {
        task.title = data.title;
        task.description = data.description;
        task.version = data.version;
        task.position = data.position;
      }
    });
    renderColumns();
  }

  function handleRemoteTaskDeleted(data) {
    if (!state.boardData || data.boardId !== state.currentBoardId) return;

    state.boardData.columns.forEach((col) => {
      col.tasks = col.tasks.filter((t) => t.id !== data.taskId);
    });
    renderColumns();
  }

  // Column Actions
  async function deleteColumn(columnId) {
    if (!confirm('Are you sure you want to delete this column and all its cards?')) return;

    try {
      const res = await apiFetch(`/api/columns/${columnId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete column');

      state.boardData.columns = state.boardData.columns.filter((c) => c.id !== columnId);
      renderColumns();
      showToast('Column deleted', 'info');
    } catch (err) {
      showToast('Error deleting column', 'danger');
    }
  }

  // Modals & Handlers
  function openAuthModal() {
    el.modalAuth.classList.remove('hidden');
    el.authEmail.focus();
  }

  function closeAuthModal() {
    el.modalAuth.classList.add('hidden');
  }

  function logoutUser() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    state.token = null;
    state.user = null;
    updateUserUI();
    if (state.socket) {
      state.socket.disconnect();
    }
    updateStatus('disconnected', 'Signed out');
  }

  // Auth Submit (Login / Register)
  el.formAuth.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el.authEmail.value.trim();
    const password = el.authPassword.value;
    if (!email || !password) return;

    const endpoint = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Authentication failed', 'danger');
        return;
      }

      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));

      updateUserUI();
      closeAuthModal();
      showToast(`Welcome, ${data.user.email}!`, 'success');

      initSocket();
      await loadBoardsList();
    } catch (err) {
      showToast('Authentication network error', 'danger');
    }
  });

  // 1-Click Instant Demo Login
  el.btnQuickDemoLogin.addEventListener('click', async () => {
    const demoEmail = `guest_${Math.random().toString(36).substring(2, 7)}@demo.collab`;
    const demoPassword = 'demopassword123';

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: demoEmail, password: demoPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Quick login failed');

      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));

      updateUserUI();
      closeAuthModal();
      showToast(`Logged in as demo guest!`, 'success');

      initSocket();
      await loadBoardsList();
    } catch (err) {
      showToast('Quick demo login failed', 'danger');
    }
  });

  // Auth Tabs
  el.tabLogin.addEventListener('click', () => {
    state.authMode = 'login';
    el.tabLogin.classList.add('active');
    el.tabRegister.classList.remove('active');
    el.authModalTitle.textContent = 'Sign In to CollabBoard';
    el.btnAuthSubmit.textContent = 'Sign In';
  });

  el.tabRegister.addEventListener('click', () => {
    state.authMode = 'register';
    el.tabRegister.classList.add('active');
    el.tabLogin.classList.remove('active');
    el.authModalTitle.textContent = 'Create New Account';
    el.btnAuthSubmit.textContent = 'Register & Sign In';
  });

  el.btnAuthToggle.addEventListener('click', () => {
    if (state.token) {
      logoutUser();
      openAuthModal();
    } else {
      openAuthModal();
    }
  });

  el.closeModalAuth.addEventListener('click', closeAuthModal);

  // Invite Member Modal
  el.btnInviteMember.addEventListener('click', () => {
    if (!state.currentBoardId) return;
    el.modalInvite.classList.remove('hidden');
    el.inviteEmail.focus();
  });

  el.closeModalInvite.addEventListener('click', () => el.modalInvite.classList.add('hidden'));
  el.cancelInviteBtn.addEventListener('click', () => el.modalInvite.classList.add('hidden'));

  el.formInviteMember.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el.inviteEmail.value.trim();
    if (!email) return;

    try {
      const res = await apiFetch(`/api/boards/${state.currentBoardId}/members`, {
        method: 'POST',
        body: JSON.stringify({ email, role: 'member' }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Failed to add member', 'danger');
        return;
      }
      showToast(`User ${email} added to board!`, 'success');
      el.modalInvite.classList.add('hidden');
      el.inviteEmail.value = '';
    } catch (err) {
      showToast('Failed to add member', 'danger');
    }
  });

  // Task Edit Modal
  function openTaskModal(task) {
    el.editTaskId.value = task.id;
    el.editTaskTitle.value = task.title;
    el.editTaskDesc.value = task.description || '';
    el.editTaskMeta.innerHTML = `
      <span>Version: ${task.version}</span>
      <span>Last Modified: ${task.updated_at ? new Date(task.updated_at).toLocaleTimeString() : 'Just now'}</span>
    `;
    el.modalTask.classList.remove('hidden');
    el.editTaskTitle.focus();
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

    if (!title) return;

    try {
      const res = await apiFetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title, description }),
      });
      if (!res.ok) throw new Error('Failed to update task');
      const updated = await res.json();

      state.boardData.columns.forEach((col) => {
        const task = col.tasks.find((t) => t.id === taskId);
        if (task) {
          task.title = updated.title;
          task.description = updated.description;
          task.version = updated.version;
        }
      });
      renderColumns();
      closeTaskModal();
      showToast('Card updated', 'success');
    } catch (err) {
      showToast('Failed to update card', 'danger');
    }
  });

  el.btnDeleteTask.addEventListener('click', async () => {
    const taskId = el.editTaskId.value;
    if (!confirm('Are you sure you want to delete this task?')) return;

    try {
      const res = await apiFetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete task');

      state.boardData.columns.forEach((col) => {
        col.tasks = col.tasks.filter((t) => t.id !== taskId);
      });
      renderColumns();
      closeTaskModal();
      showToast('Card deleted', 'info');
    } catch (err) {
      showToast('Failed to delete card', 'danger');
    }
  });

  // Add Column Button
  el.btnAddColumn.addEventListener('click', async () => {
    if (!state.currentBoardId) return;
    const title = prompt('Enter column title:');
    if (!title || !title.trim()) return;

    try {
      const res = await apiFetch(`/api/boards/${state.currentBoardId}/columns`, {
        method: 'POST',
        body: JSON.stringify({ title: title.trim() }),
      });
      if (!res.ok) throw new Error('Failed to create column');
      const newCol = await res.json();
      state.boardData.columns.push(newCol);
      renderColumns();
      showToast('Column added', 'success');
    } catch (err) {
      showToast('Failed to create column', 'danger');
    }
  });

  // Create Board Modal
  el.btnNewBoard.addEventListener('click', () => {
    el.modalBoard.classList.remove('hidden');
    el.boardTitleInput.focus();
  });

  el.closeModalBoard.addEventListener('click', () => el.modalBoard.classList.add('hidden'));
  el.cancelBoardBtn.addEventListener('click', () => el.modalBoard.classList.add('hidden'));

  el.formCreateBoard.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = el.boardTitleInput.value.trim();
    if (!title) return;

    try {
      const res = await apiFetch('/api/boards', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error('Failed to create board');
      const newBoard = await res.json();
      el.modalBoard.classList.add('hidden');
      el.boardTitleInput.value = '';
      showToast(`Board "${newBoard.title}" created!`, 'success');
      await loadBoardsList();
      selectBoard(newBoard.id);
    } catch (err) {
      showToast('Failed to create board', 'danger');
    }
  });

  // Board Selector change event
  el.boardSelect.addEventListener('change', (e) => {
    selectBoard(e.target.value);
  });

  // Initial Boot
  async function boot() {
    updateUserUI();
    if (state.token) {
      initSocket();
      await loadBoardsList();
    } else {
      updateStatus('disconnected', 'Sign in required');
      openAuthModal();
    }
  }

  boot();
})();
