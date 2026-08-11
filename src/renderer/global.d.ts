import type { DiagnosticsSnapshot, HubSnapshot, SearchHit, SearchQuery } from "../shared/protocol";

declare global {
  interface Window {
    agentPet: {
      snapshot(): Promise<HubSnapshot>;
      search(query: SearchQuery): Promise<SearchHit[]>;
      diagnostics(): Promise<DiagnosticsSnapshot>;
      simulate(kind?: string): Promise<HubSnapshot>;
      setMousePassthrough(enabled: boolean): void;
      hideWindow(): void;
      onSnapshot(listener: (snapshot: HubSnapshot) => void): () => void;
      onPetMotion(listener: (direction: "left" | "right") => void): () => void;
    };
  }
}

export {};
