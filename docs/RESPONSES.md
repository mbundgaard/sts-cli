# Verbatim response delivery

STS manages authentication/tokens, builds explicit requests and delivers API data
verbatim. All STS API reads, calculator calls and check writes share one automatic
response handler. No output-mode flag, agent detection or configuration switch.
Auth, feedback, update lookup and local commands retain their separate behavior.

## Thresholds

After HTTP compression decoding:

- At most **16,384 bytes (16 KiB) and 500 lines**: stdout receives the exact body.
- Above **either** limit: the complete body is saved unchanged to a private file;
  stdout receives only a compact JSON delivery receipt, not a preview or summary.

Bytes are not Unicode characters. Lines are LF-delimited; CRLF counts once and a
final newline does not add an empty line. Empty bodies have zero lines. No parsing,
reformatting, redaction, rounding, truncation or extra newline is applied to API
bodies. Gzip/deflate/Brotli decoding is transport processing. Non-JSON/binary bodies
and error responses follow the same policy. HEAD remains empty stdout, with
Simphony-POS-Connected diagnostics on stderr when present and not quiet.

## File receipt

Illustrative shape:

```json
{
  "delivery": "file",
  "path": "/home/example/.config/StsCli/responses/response-AbCdEf/response.body",
  "uri": "file:///home/example/.config/StsCli/responses/response-AbCdEf/response.body",
  "bytes": 25000,
  "lines": 1200,
  "sha256": "<SHA-256 of the exact saved body>",
  "httpStatus": 200,
  "description": "Large Oracle STS GET response, saved verbatim.",
  "instructions": "Filter, aggregate, or read selected portions of this file instead of loading it all into context. Keep it private and delete it when no longer needed."
}
```

This is CLI delivery metadata, not an API response wrapper or a success claim.
The description comes from the request method, never from parsing customer records.
No token, request body, customer identifiers or sample records are included.
The `.body` extension avoids assuming the response is JSON. The URI is a local file
reference, not a public download link. The file hash allows byte-integrity checks.

API HTTP status and exit codes remain unchanged: 401 exits 9; other non-success
exits 11. `--quiet` hides HTTP diagnostics, not bodies, receipts or local errors.

## Agents and existing scripts

Check the process exit code and handle either an inline body or a file receipt
(`delivery: "file"` with path/status/size metadata). Read/filter/aggregate the file
with local tools instead of loading it wholesale into agent context. Choose JSON
processors that preserve large identifiers and monetary precision.

This changes stdout for oversized responses. Shell redirection such as
`> response.json` can now capture a **receipt**, not the original API body. Use its
`path` to access the full body. There is no flag to force oversized inline output.

Prefer explicit, narrow requests where possible: location/RVC scope, check-number
and since-time filters, or documented offset/limit pagination on supporting read
endpoints. Do not invent pagination or assume one response is complete. Delivery
never silently filters records, changes requests, follows redirects or repeats calls.

## Storage and failures

Exports live in the fixed per-user StsCli directory, separate from BiCli:

- Windows: `C:\Users\<user>\AppData\Roaming\StsCli\responses\`
- macOS: `~/Library/Application Support/StsCli/responses/`
- Linux: `~/.config/StsCli/responses/`

Every export gets a unique directory; filenames contain no tenant/check identifiers.
Unix directories use 0700 and files 0600. Windows directories receive an explicit
current-user-only inheritable ACL before response bytes are written. Protection
failure fails closed. Privileged OS administrators can still access private files.

Only the small inline candidate stays in memory. Oversized decoded chunks stream
with backpressure into `response.part`. After successful transfer/decompression,
the file is synced, closed and renamed to `response.body` before a receipt is emitted.
Completed files have **no automatic expiry**; delete them when no longer needed.

Network/decode failures and handled cancellation remove partial files and emit no
API body/receipt. Storage failures exit 1 rather than dumping a large body into
stdout or falling back to unbounded RAM. Failed cleanup reports the private partial
path for manual attention. Crashes, hard termination or power loss can leave private
`.part` files; they are never advertised as completed responses.

**A failed download or file save does not undo a POS write.** POST/DELETE failure
diagnostics retain the uncertain-outcome warning. Never blindly retry; reconcile
first or deliberately reuse the existing explicit idempotency ID where supported.
Response delivery adds no retry, TLS bypass or broader query. Company token
maintenance runs separately before API calls; see [Authentication](AUTHENTICATION.md).
Completed files are retained if stdout delivery fails after finalization.

Auth token responses are still parsed internally and never exported by this handler.
Feedback and npm update requests remain separate. Successful API calls still count
for optional local feedback reminders; recording a receipt is not feedback consent.
Do not publish response files, payment/personnel data or private paths in reports.

Tests use synthetic loopback responses, including 128 MiB plain/compressed bodies,
exact file hashes, thresholds, errors, cancellation and storage failures. Native
Windows ACL checks run locally; configured cross-platform CI is not proof that
native macOS/Linux jobs have run.
