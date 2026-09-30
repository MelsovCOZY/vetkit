import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

// vet accepts OTLP over HTTP with a JSON body only: this exporter sends application/json, and
// the equivalent for an env-configured exporter is OTEL_EXPORTER_OTLP_PROTOCOL=http/json.
const port = process.env['VET_OTLP_PORT'] ?? '4318';

export const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: `http://127.0.0.1:${port}/v1/traces` }),
});

sdk.start();
