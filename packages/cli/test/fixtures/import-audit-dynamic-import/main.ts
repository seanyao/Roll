// Entry fixture: contains a dynamic import() call — the audit must reject this.
const x = import("./nonexistent.js");
