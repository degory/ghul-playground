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

// One cell of an interactive session is compiled against the assemblies of the
// cells before it, which the page holds and posts with each request. A cell
// assembly weighs about 3 KB, so these allow a session of 128 cells averaging
// 8 KB each: far longer and heavier than anyone types into a REPL, while still
// bounding what one request can make the service decode and write to disk.
const MAX_REFERENCES = Number(process.env.MAX_REFERENCES ?? 128);
const MAX_REFERENCE_BYTES = Number(process.env.MAX_REFERENCE_BYTES ?? 1024 * 1024);

// The most a request body can hold: the source, the references as base64
// (four characters for every three bytes), and the JSON around them.
const MAX_REQUEST_BYTES =
    MAX_SOURCE_BYTES + Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 16 * 1024;

module.exports = {
    MAX_SOURCE_BYTES, MAX_REFERENCES, MAX_REFERENCE_BYTES, MAX_REQUEST_BYTES
};
