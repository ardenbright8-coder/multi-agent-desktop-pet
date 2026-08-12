import type { DiagnosticsSnapshot, HubSnapshot, InteractionResponseInput, InteractionSubmitResult, SearchHit, SearchQuery } from "../../shared/protocol";

declare global {
  interface Window {
    agentPet: {
      snapshot(): Promise<HubSnapshot>;
      search(query: SearchQuery): Promise<SearchHit[]>;
      diagnostics(): Promise<DiagnosticsSnapshot>;
      simulate(kind?: string): Promise<HubSnapshot>;
      respondInteraction(response: InteractionResponseInput): Promise<InteractionSubmitResult>;
      moveWindowToPointer(position: { screenX: number; screenY: number; anchorX: number; anchorY: number }): void;
      finishWindowMove(): void;
      setPetPickedUp(pickedUp: boolean): void;
      setPanelVisibility(visible: boolean): void;
      hideWindow(): void;
      onSnapshot(listener: (snapshot: HubSnapshot) => void): () => void;
    };
  }
}

export {};
