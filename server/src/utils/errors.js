// Custom error so routes can send the right HTTP status (400 / 404 / 409)
export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
