import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll } from "vitest";

/** Registers a real OTel SDK with an in-memory exporter for the duration of a test file. */
export function useInMemoryTracing(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  const contextManager = new AsyncLocalStorageContextManager();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
    trace.setGlobalTracerProvider(provider);
  });
  afterEach(() => exporter.reset());
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });
  return exporter;
}
