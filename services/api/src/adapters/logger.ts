import type { LogFields, Logger } from '../core/ports.js';

/**
 * One JSON object per line, which is what CloudWatch Logs Insights can query.
 * Plain console.log of interpolated strings is not searchable in practice.
 */
export function createJsonLogger(context: LogFields = {}): Logger {
  const emit = (level: string, message: string, fields: LogFields | undefined): void => {
    const line = JSON.stringify({
      level,
      message,
      ...context,
      ...(fields ?? {}),
      timestamp: new Date().toISOString(),
    });

    if (level === 'error') {
      console.error(line);
      return;
    }
    console.log(line);
  };

  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
