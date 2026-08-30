import { Router } from "express";
import { createCallsRouter } from "../calls/calls.routes";
import { CallsService } from "../calls/calls.service";
import { createRealtimeRouter } from "../realtime/realtime.routes";
import type { RealtimeService } from "../realtime/realtime.service";
import { createWebhooksRouter } from "../webhooks/webhooks.routes";
import type { WebhooksService } from "../webhooks/webhooks.service";
import {
  createVoiceRuntime,
  type CreateVoiceRuntimeOptions,
  type VoiceRuntime,
} from "./voice.runtime";

export interface CreateVoiceRouterOptions {
  runtime?: VoiceRuntime;
  callsService?: CallsService;
  realtimeService?: RealtimeService;
  webhooksService?: WebhooksService;
  publicBaseUrl?: string;
  runtimeOptions?: CreateVoiceRuntimeOptions;
}

export function resolveVoiceRuntime(
  options: CreateVoiceRouterOptions = {},
): VoiceRuntime {
  return (
    options.runtime ??
    createVoiceRuntime({
      ...options.runtimeOptions,
      callsService: options.callsService ?? options.runtimeOptions?.callsService,
      realtimeService:
        options.realtimeService ?? options.runtimeOptions?.realtimeService,
      webhooksService:
        options.webhooksService ?? options.runtimeOptions?.webhooksService,
      publicBaseUrl:
        options.publicBaseUrl ?? options.runtimeOptions?.publicBaseUrl,
    })
  );
}

export function createVoiceRouter(options: CreateVoiceRouterOptions = {}): Router {
  const router = Router();
  const runtime = resolveVoiceRuntime(options);

  router.use(createCallsRouter(runtime.callsService));
  router.use(createRealtimeRouter(runtime.realtimeService));
  router.use(
    createWebhooksRouter({
      service: runtime.webhooksService,
      publicBaseUrl: runtime.publicBaseUrl,
    }),
  );

  return router;
}
