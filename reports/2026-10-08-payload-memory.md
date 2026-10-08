# WUHU-134: gateway payload and record measurements

Measured on devbox with Deno 2.9.1 and pinned Claude Code 2.1.284, using only an offline fake Anthropic endpoint. The same serialized WebSocket full-create fixture is exactly 104,857,600 bytes (100 MiB), SHA-256 `b07d96e3f1731efb64c0e0adaaecb26bceda05c9ec0ddaf502443ac5ef5a1764`: 129 deterministic 450×450 noise PNGs in completed historical groups, a small current user query, and deterministic text padding. Requests use 16 MiB WebSocket fragments. The fake reply explicitly reports 50,000 input tokens; base64 character count is not treated as text token count.

The gateway runs in its own Deno process; `/proc/self/status` VmHWM measures that process only, excluding the driver, fake backend and Claude Code child. Measurements include request parsing, synthesized-log construction, native inference, record encoding and terminal preflight. Successful runs additionally include durable store and terminal enqueue. Thus the original failing run stops earlier, not at the same success boundary.

| Implementation | Outcome | Opaque provider record bytes | Gateway peak RSS (KiB) |
| --- | --- | ---: | ---: |
| Original `9fb1f6b` | Deterministic `websocket_backpressure`; no committed response | 105,077,979 | 1,485,080 |
| F1/F2 `7923a63` | Completed and committed | 105,077,963 | 1,791,456 |
| Slim-record implementation | Completed and committed | 4,855 | 593,900 |

Record UUIDs/timestamps and gzip size can vary slightly between runs. F1/F2 removes duplicate WebSocket opaque emissions, request-body retention, retained covered-input copies, full-request digest copies and byte-count-only UTF-8 allocations. It enables success but does not by itself reduce the observed peak below the earlier preflight failure. Slim records eliminate input-sized opaque encoding and retransmission, reducing measured peak by 60% relative to the original failing path and by 67% relative to the successful F1/F2 path.

The gateway's synthesized log contains all 129 fixture images, but the pinned SDK's upstream request contains 90 in both original and fixed runs. This is a separate native SDK context/image policy, not gateway truncation or a WebSocket cap. Its precise cap was not established by this measurement; extreme image histories sent by the kernel through this SDK can consequently omit older images upstream. The separate real 60-image regression verifies all 60 are delivered, records remain small, and live versus recovered upstream requests are byte-identical.

New records contain Claude's own output plus payload-free replay templates, while native image bytes (including PNG→JPEG conversions) are stored by SHA-256 in durable sidecars. With sidecars, recovery is byte-exact even if response JSON files are lost. With complete state loss, references regenerate from full input and native image bytes can take a one-time cache break; a persisted hash alias prevents repeated breaks. Existing fat records remain byte-exact without sidecars. No transport fallback, concurrency restriction, or live deployment is part of this change.
