# Vendored OTLP `.proto` definitions

These files are unmodified copies of the official OpenTelemetry Protocol
buffers, vendored from the canonical upstream repository so the OTLP-HTTP
protobuf ingest path (`src/lib/otlp/protobuf-decode.ts`) can decode incoming
`http/protobuf`-encoded `ExportMetricsServiceRequest` / `ExportLogsServiceRequest`
bodies using the real schema, rather than a hand-rolled binary parser.

Source: https://github.com/open-telemetry/opentelemetry-proto (Apache 2.0),
`main` branch, fetched 2026-07-04. Files:

- `opentelemetry/proto/common/v1/common.proto`
- `opentelemetry/proto/resource/v1/resource.proto`
- `opentelemetry/proto/metrics/v1/metrics.proto`
- `opentelemetry/proto/logs/v1/logs.proto`
- `opentelemetry/proto/collector/metrics/v1/metrics_service.proto`
- `opentelemetry/proto/collector/logs/v1/logs_service.proto`

Loaded at runtime by [`protobufjs`](https://www.npmjs.com/package/protobufjs)
(Google's official/canonical JS protobuf library — this project does not hand
-roll wire-format decoding). Why vendor `.proto` text instead of depending on
`@opentelemetry/otlp-transformer`: that package's public API
(`ProtobufMetricsSerializer` / `ProtobufLogsSerializer`) only exposes
`serializeRequest` (SDK data -> bytes, for exporters) and
`deserializeResponse` (parses a collector's ack response) — it has no public
API for decoding an *incoming* `ExportMetricsServiceRequest`/`ExportLogsServiceRequest`
on the receiving end, which is what a server-side ingest route needs. Loading
the same upstream `.proto` schema directly via `protobufjs` is the standard
approach OTLP-compatible receivers use for this.

Update by re-fetching from the same upstream paths; do not hand-edit these
files.
