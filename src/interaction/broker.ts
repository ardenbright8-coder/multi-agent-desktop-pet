import { randomUUID } from "node:crypto";
import type {
  InteractionResponseClaim,
  InteractionResponseInput,
  InteractionSubmitResult,
} from "../shared/protocol";
import { createLogger } from "../shared/log";

const log = createLogger("permission");

interface QueuedResponse extends InteractionResponseInput {
  responseId: string;
  claimToken?: string;
  claimedAt?: number;
  timer: NodeJS.Timeout;
  finish(result: InteractionSubmitResult): void;
}

export class InteractionBroker {
  private readonly queued = new Map<string, QueuedResponse>();
  private readonly completed = new Map<string, number>();

  constructor(
    private readonly validate: (input: InteractionResponseInput) => boolean,
    private readonly updateStatus: (input: InteractionResponseInput, status: "submitting" | "failed" | "submitted", error?: string) => void,
    private readonly timeoutMs = 20_000,
  ) {}

  submit(input: InteractionResponseInput): Promise<InteractionSubmitResult> {
    this.cleanupCompleted();
    if (this.completed.has(input.eventId) || this.queued.has(input.eventId)) {
      return Promise.resolve({ ok: false, status: "duplicate", message: "这次回答已经提交或正在提交，请不要重复操作。" });
    }
    if (!this.validate(input)) {
      return Promise.resolve({ ok: false, status: "unavailable", message: "这条待处理事项已经变化，请回会话列表重新打开。" });
    }

    log.记(`用户在桌宠上交了答案 agent=${input.agent} 会话=${input.sessionId} 共${input.answers?.length ?? 0}题`, "submit");
    this.updateStatus(input, "submitting");
    return new Promise((resolve) => {
      const responseId = randomUUID();
      const finish = (result: InteractionSubmitResult) => resolve(result);
      const timer = setTimeout(() => {
        const queued = this.queued.get(input.eventId);
        if (!queued || queued.responseId !== responseId) return;
        this.queued.delete(input.eventId);
        const message = "Agent 没有在限定时间内接收回答，请回原窗口处理或稍后重试。";
        log.出事(`答案等了 ${this.timeoutMs}ms 没人接，退回原窗口 agent=${input.agent} 会话=${input.sessionId}`, undefined, "submit");
        this.updateStatus(input, "failed", message);
        finish({ ok: false, status: "failed", message });
      }, this.timeoutMs);
      timer.unref();
      this.queued.set(input.eventId, { ...input, responseId, timer, finish });
    });
  }

  claim(binding: Pick<InteractionResponseInput, "eventId" | "agent" | "sessionId" | "providerRequestId">): InteractionResponseClaim | null {
    const queued = this.queued.get(binding.eventId);
    if (!queued || queued.agent !== binding.agent || queued.sessionId !== binding.sessionId || queued.providerRequestId !== binding.providerRequestId) return null;
    if (queued.claimedAt && Date.now() - queued.claimedAt < 2_500) return null;
    queued.claimToken = randomUUID();
    queued.claimedAt = Date.now();
    return {
      responseId: queued.responseId,
      claimToken: queued.claimToken,
      eventId: queued.eventId,
      agent: queued.agent,
      sessionId: queued.sessionId,
      providerRequestId: queued.providerRequestId,
      answers: queued.answers,
    };
  }

  complete(responseId: string, claimToken: string, success: boolean, error?: string): boolean {
    const queued = [...this.queued.values()].find((item) => item.responseId === responseId);
    if (!queued || queued.claimToken !== claimToken) return false;
    clearTimeout(queued.timer);
    this.queued.delete(queued.eventId);
    if (success) {
      log.记(`答案已交回 agent=${queued.agent} 会话=${queued.sessionId}`, "complete");
      this.completed.set(queued.eventId, Date.now() + 30 * 60 * 1000);
      this.updateStatus(queued, "submitted");
      queued.finish({ ok: true, status: "submitted", message: "回答已交回 Agent。" });
    } else {
      const message = error?.trim().slice(0, 500) || "Agent 接收回答失败，请回原窗口处理或重试。";
      this.updateStatus(queued, "failed", message);
      queued.finish({ ok: false, status: "failed", message });
    }
    return true;
  }

  private cleanupCompleted(): void {
    const now = Date.now();
    for (const [eventId, expiresAt] of this.completed) if (expiresAt <= now) this.completed.delete(eventId);
  }
}
