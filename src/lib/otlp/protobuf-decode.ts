import path from "path";
import protobuf from "protobufjs";
import type { OtlpExportLogsServiceRequest, OtlpExportMetricsServiceRequest } from "./types";

// Decodes OTLP-HTTP `Content-Type: application/x-protobuf` request bodies.
//
// Claude Code defaults OTEL_EXPORTER_OTLP_PROTOCOL to `grpc`, but supports
// `http/protobuf` and `http/json` as documented alternatives
// (https://code.claude.com/docs/en/monitoring-usage). This route's primary
// target is `http/json` (see json-decode.ts) since that's what the
// coordinator is expected to configure, but protobuf is decoded here too so
// the endpoint doesn't reject a client configured with
// OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf. gRPC itself (HTTP/2 + protobuf
// framing + trailers) is NOT supported by this Next.js route — see the route
// file for the explicit 415 returned when a gRPC content-type is detected.
//
// Rather than hand-roll protobuf wire-format parsing, this loads the actual
// upstream OTLP `.proto` schema (vendored in ./proto, see proto/README.md)
// through protobufjs, the canonical JS protobuf library. The message is
// decoded generically via protobufjs's reflection API and then converted to
// the same plain-JSON shape (OtlpExportMetricsServiceRequest /
// OtlpExportLogsServiceRequest) that json-decode.ts produces, so
// claude-code-mapper.ts has exactly one shape to deal with regardless of
// which wire encoding the client used.

let root: protobuf.Root | undefined;

function loadRoot(): protobuf.Root {
  if (root) return root;
  const protoDir = path.join(process.cwd(), "src/lib/otlp/proto");
  root = new protobuf.Root();
  root.resolvePath = (originPath: string, importPath: string) =>
    path.isAbsolute(importPath) ? importPath : path.join(protoDir, importPath);
  // NOT keepCase: proto3's canonical JSON mapping (which the OTLP JSON
  // encoding follows, and which types.ts/json-decode.ts are written against)
  // lowerCamelCases every field name (data_points -> dataPoints,
  // time_unix_nano -> timeUnixNano, etc), even though the .proto source uses
  // snake_case. protobufjs's default (keepCase left false) already performs
  // this exact conversion, so decoding via protobuf and via JSON converge on
  // the identical shape.
  root.loadSync([
    "opentelemetry/proto/collector/metrics/v1/metrics_service.proto",
    "opentelemetry/proto/collector/logs/v1/logs_service.proto",
  ]);
  return root;
}

function toPlainObject(message: protobuf.Message, type: protobuf.Type): unknown {
  // protobufjs's toObject with longs-as-strings + enums-as-numbers matches
  // the proto3 canonical JSON mapping this app's types.ts (and json-decode.ts)
  // already expect: int64 -> decimal string, enum -> number.
  return type.toObject(message, {
    longs: String,
    enums: Number,
    bytes: String,
    defaults: false,
  });
}

export function decodeMetricsProtobuf(body: Buffer | Uint8Array): OtlpExportMetricsServiceRequest {
  const loadedRoot = loadRoot();
  const RequestType = loadedRoot.lookupType(
    "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest"
  );
  const message = RequestType.decode(body);
  return toPlainObject(message, RequestType) as OtlpExportMetricsServiceRequest;
}

export function decodeLogsProtobuf(body: Buffer | Uint8Array): OtlpExportLogsServiceRequest {
  const loadedRoot = loadRoot();
  const RequestType = loadedRoot.lookupType(
    "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest"
  );
  const message = RequestType.decode(body);
  return toPlainObject(message, RequestType) as OtlpExportLogsServiceRequest;
}
