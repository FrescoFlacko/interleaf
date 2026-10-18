import { InterleafError, type InterleafErrorCode } from '@shared/errors/interleaf-error';
import { redactString } from '../logging/logger';

export type FatalBootstrapDiagnostic = {
  readonly errorType: string;
  readonly code: InterleafErrorCode | 'internal';
  readonly category: string;
  readonly message: string;
};

export function formatFatalBootstrapDiagnostic(error: Error | null): FatalBootstrapDiagnostic {
  if (error instanceof InterleafError) {
    return {
      errorType: error.name,
      code: error.code,
      category: error.code,
      message: redactString(error.message),
    };
  }

  if (error instanceof Error) {
    return {
      errorType: error.name.trim().length > 0 ? error.name : 'Error',
      code: 'internal',
      category: 'internal',
      message: redactString(error.message),
    };
  }

  // Nothing an error was not: the value a catch block could not vouch for is
  // reported as a startup failure without a description of its own.
  return {
    errorType: 'unknown',
    code: 'internal',
    category: 'internal',
    message: 'An unknown fatal error occurred during startup.',
  };
}

export type BootstrapResources = {
  database?: { close(): void } | null;
  assetRegistry?: { clear(): void } | null;
  assetSweepTimer?: NodeJS.Timeout | null;
  managedOrphanSweepTimer?: NodeJS.Timeout | null;
  chatService?: { shutdown(): Promise<void> } | null;
  agentService?: { shutdown(): Promise<void> } | null;
  flushLogs?: () => Promise<void>;
  resetLogs?: () => void;
};

export async function cleanupBootstrapResources(resources: BootstrapResources): Promise<void> {
  if (resources.assetSweepTimer != null) {
    try {
      clearInterval(resources.assetSweepTimer);
    } catch {
      // Ignore timer clearing errors
    }
  }
  if (resources.managedOrphanSweepTimer != null) {
    try {
      clearInterval(resources.managedOrphanSweepTimer);
    } catch {
      // Ignore timer clearing errors
    }
  }
  if (resources.assetRegistry != null) {
    try {
      resources.assetRegistry.clear();
    } catch {
      // Ignore registry cleanup errors on fatal exit
    }
  }
  if (resources.chatService != null) {
    try {
      await resources.chatService.shutdown();
    } catch {
      // Ignore service shutdown errors on fatal exit
    }
  }
  if (resources.agentService != null) {
    try {
      await resources.agentService.shutdown();
    } catch {
      // Ignore service shutdown errors on fatal exit
    }
  }
  if (resources.database != null) {
    try {
      resources.database.close();
    } catch {
      // Ignore database close errors on fatal exit
    }
  }
  if (resources.flushLogs != null) {
    try {
      await resources.flushLogs();
    } catch {
      // Durable sink flush failure handled safely; do not throw or leak errors
    }
  }
  if (resources.resetLogs != null) {
    try {
      resources.resetLogs();
    } catch {
      // Ignore reset logging errors
    }
  }
}
