const ANSI_CSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_PATTERN = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
// DCS (Device Control String), SOS, PM, APC sequences: ESC P/X/^/_ ... ST
const ANSI_DCS_PATTERN = /\u001BP[^\u001B]*(?:\u001B\\|\u009C)/g;
const ANSI_APC_SOS_PM_PATTERN = /\u001B[X^_][^\u001B]*(?:\u001B\\|\u009C)/g;
// Raw ESC sequences (e.g., ESC c = reset, ESC 7 = save cursor, ESC[?1049h = alt screen)
const ANSI_RAW_ESC_PATTERN = /\u001B[^[\]PX^_]/g;
const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(ANSI_DCS_PATTERN, "")
    .replace(ANSI_APC_SOS_PM_PATTERN, "")
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_RAW_ESC_PATTERN, "")
    .replace(/\r/g, "")
    .replace(CONTROL_CHARS_PATTERN, "")
    .trim();
}
