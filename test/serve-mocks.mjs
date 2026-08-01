// Keep the four mock providers alive for interactive testing.
import { startOpenAIMock, startAnthropicMock, startTtsMock, startMcpMock } from "./mocks.mjs";
await startOpenAIMock(4310);
await startAnthropicMock(4311);
await startTtsMock(4312);
await startMcpMock(4313);
console.log("mocks up on 4310-4313");
setInterval(() => {}, 60_000);
