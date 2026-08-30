export {};

declare global {
  interface Window {
    cyAnnotaDesktop?: {
      chooseSaveFile(input: {
        name: string;
      }): Promise<{
        canceled: boolean;
        token?: string;
        fileName?: string;
        renamed?: boolean;
      }>;
      readClipboardFiles(): Promise<Array<{
        name: string;
        type: string;
        bytes: ArrayBuffer;
      }>>;
      beginSaveFile(input: {
        token: string;
      }): Promise<{ started: boolean }>;
      writeSaveChunk(input: {
        token: string;
        base64: string;
      }): Promise<{ written: number }>;
      finishSaveFile(input: {
        token: string;
        copyToClipboard?: boolean;
      }): Promise<{
        saved: boolean;
        bytesWritten: number;
        copied: boolean;
        copyError?: string;
        fileName?: string;
        renamed?: boolean;
      }>;
      abortSaveFile(input: {
        token: string;
      }): Promise<{ aborted: boolean }>;
      showErrorMessage(input: {
        title: string;
        message: string;
        detail: string;
      }): Promise<{ shown: boolean }>;
      onOpenFiles(callback: (items: Array<{
        name: string;
        type: string;
        bytes: ArrayBuffer;
      }>) => void): () => void;
    };
  }
}
