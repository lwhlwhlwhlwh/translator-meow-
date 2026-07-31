export type Settings = { baseUrl: string; model: string; sourceLang: string; targetLang: string; concurrency: number; apiKeyConfigured: boolean };
export type RuntimeSettings = Omit<Settings, 'apiKeyConfigured'> & { apiKey: string };
export type TranslationRequest = { text: string; settings: RuntimeSettings; signal?: AbortSignal; rateLimitGate?: RateLimitGate; onStatus?: (message: string) => void };
export type RateLimitGate = {
  wait(signal?: AbortSignal): Promise<number>;
  pause(delayMs: number): void;
  resume(ticket: number): void;
};
export type ProgressEvent = { current: number; total: number; message: string; warning?: string };
export type TranslationResult = { text: string; warning?: string };
export type AppApi = {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  updateApiKey(apiKey: string): Promise<Settings>;
  translateText(text: string, settings: Settings): Promise<TranslationResult>;
  chooseInput(): Promise<string | null>;
  chooseOutput(defaultPath: string): Promise<string | null>;
  translateDocument(input: string, output: string, settings: Settings): Promise<void>;
  cancel(): Promise<void>;
  onProgress(callback: (event: ProgressEvent) => void): () => void;
};
declare global { interface Window { app: AppApi } }
