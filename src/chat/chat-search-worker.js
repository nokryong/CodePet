const {parentPort, workerData} = require('node:worker_threads');
const {ChatStore} = require('./chat-store');
// Read a snapshot without initializing or acquiring writer ownership.
const store = new ChatStore({root:workerData.root});
store.index.sessions = workerData.sessions;
parentPort.postMessage(store.searchSessions(workerData.query));
