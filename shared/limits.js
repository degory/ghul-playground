// How large a program the services will accept.
//
// Both services and the front end have to agree, so the number lives here and
// is reported over `/health` for the front end to read rather than being copied
// into it. A limit the editor does not know about is one a reader only
// discovers by having a paste rejected with no explanation.
//
// 32 KB is far more than anything anyone will type into a playground - the
// compiler's own largest source file is smaller - while being small enough
// that flooding the service with large bodies is not worth attempting. The
// bound that actually protects the box is the concurrency cap; this one keeps
// a single request cheap.

const MAX_SOURCE_BYTES = Number(process.env.MAX_SOURCE_BYTES ?? 32 * 1024);

module.exports = { MAX_SOURCE_BYTES };
