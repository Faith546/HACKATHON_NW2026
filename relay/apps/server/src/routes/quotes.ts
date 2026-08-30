import type { FastifyPluginAsync } from "fastify";
import { quoteStore } from "../stores/quote-store.js";

const quoteRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { callId: string } }>(
    "/api/calls/:callId/quotes",
    async (request) => ({
      callId: request.params.callId,
      quotes: await quoteStore.getQuotesForCall(request.params.callId),
    }),
  );
};

export default quoteRoutes;
