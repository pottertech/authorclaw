/**
 * AuthorClaw TTS Service
 * Text-to-speech using Piper TTS (local, free, MIT-licensed)
 *
 * Generates audio files from text. Supports WAV output and OGG conversion
 * for Telegram voice messages. Gracefully degrades if Piper is not installed.
 */

import { exec } from 'child_process';
import { mkdir, readdir, stat, readFile, unlink, access, constants } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { randomBytes } from 'crypto';

const execAsync = promisify(exec);

export interface TTSResult {
  success: boolean;
  file?: string;
  filename?: string;
  format?: string;
  size?: number;
  error?: string;
}

export interface TTSVoice {
  name: string;
  language: string;
  quality: string;
}

export class TTSService {
  private audioDir: string;
  private configDir: string;
  private piperAvailable: boolean | null = null;
  private piperPath: string = 'piper'; // Resolved full path to piper binary
  private ffmpegAvailable: boolean | null = null;
  private ffmpegPath: string = 'ffmpeg'; // Resolved full path to ffmpeg binary
  private defaultVoice = 'en_US-lessac-medium';
  private configuredVoice: string | null = null;

  // Known good Piper voices with human-readable descriptions
  static readonly KNOWN_VOICES: Record<string, string> = {
    'en_US-lessac-medium': 'Lessac (US, clear & natural — recommended)',
    'en_US-lessac-high': 'Lessac High (US, best quality, slower)',
    'en_US-libritts-high': 'LibriTTS (US, expressive, great for fiction)',
    'en_US-amy-medium': 'Amy (US, warm female voice)',
    'en_US-arctic-medium': 'Arctic (US, neutral)',
    'en_US-ryan-medium': 'Ryan (US, male)',
    'en_GB-alba-medium': 'Alba (British, clear)',
    'en_GB-jenny_dioco-medium': 'Jenny (British, warm)',
  };

  // Common installation paths for Piper TTS (pip, pipx, system, snap, etc.)
  private static readonly PIPER_SEARCH_PATHS: string[] = [
    'piper', // Already on PATH
    '/usr/local/bin/piper',
    '/usr/bin/piper',
    // pipx installs (the #1 miss — Ubuntu 24.04 forces pipx over pip)
    `${process.env.HOME || '/root'}/.local/bin/piper`,
    `${process.env.HOME || '/root'}/.local/share/pipx/venvs/piper-tts/bin/piper`,
    // pip user installs
    `${process.env.HOME || '/root'}/.local/lib/python3.12/site-packages/piper/__main__.py`,
    `${process.env.HOME || '/root'}/.local/lib/python3.11/site-packages/piper/__main__.py`,
    // snap / flatpak
    '/snap/bin/piper',
  ];

  constructor(workspaceDir: string) {
    this.audioDir = join(workspaceDir, 'audio');
    this.configDir = join(workspaceDir, '.config');
  }

  async initialize(): Promise<void> {
    // Create audio output directory
    await mkdir(this.audioDir, { recursive: true });
    await mkdir(this.configDir, { recursive: true });

    // Load persisted voice preference
    await this.loadVoiceConfig();

    // Find Piper TTS — search common installation paths
    this.piperPath = await this.findBinary(TTSService.PIPER_SEARCH_PATHS, '--help');
    this.piperAvailable = this.piperPath !== '';

    // Find ffmpeg — search common paths
    this.ffmpegPath = await this.findBinary(['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'], '-version');
    this.ffmpegAvailable = this.ffmpegPath !== '';

    // TTS status logged at debug level only (hidden from startup banner)
    // Piper is optional — no warnings if not installed
  }

  /**
   * Search a list of candidate paths for a binary.
   * Returns the first working path, or '' if none found.
   *
   * Strategy for absolute paths: check exists + executable permission.
   * Many CLI tools (like piper-tts) exit non-zero on --help, so we
   * don't require the test command to succeed for known file paths.
   */
  private async findBinary(candidates: string[], testArg: string): Promise<string> {
    for (const candidate of candidates) {
      // Skip __main__.py style paths — need python invocation
      if (candidate.endsWith('.py')) {
        try {
          await access(candidate, constants.X_OK);
          return `python3 "${candidate}"`;
        } catch { continue; }
      }

      const isAbsolute = candidate.startsWith('/') || candidate.startsWith(process.env.HOME || '/nope');

      if (isAbsolute) {
        // For absolute paths: just verify the file exists and is executable
        // Don't require --help to succeed (piper-tts exits non-zero on --help)
        try {
          await access(candidate, constants.X_OK);
          return candidate;
        } catch { continue; }
      } else {
        // For bare command names (e.g. "piper", "ffmpeg"): try running it
        try {
          await execAsync(`${candidate} ${testArg}`, { timeout: 10000 });
          return candidate;
        } catch { continue; }
      }
    }

    // Last resort: try `which` / `command -v` (catches anything on extended PATH)
    try {
      const { stdout } = await execAsync(`which ${candidates[0]} 2>/dev/null || command -v ${candidates[0]} 2>/dev/null`, { timeout: 5000 });
      const found = stdout.trim();
      if (found) {
        try {
          await access(found, constants.X_OK);
          return found;
        } catch { /* found but not executable */ }
      }
    } catch { /* which/command not available */ }
    return '';
  }

  /** Load persisted voice config from workspace/.config/tts.json */
  private async loadVoiceConfig(): Promise<void> {
    const configPath = join(this.configDir, 'tts.json');
    try {
      const raw = await readFile(configPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config.voice && typeof config.voice === 'string') {
        this.configuredVoice = config.voice;
      }
    } catch { /* no config yet — use default */ }
  }

  /** Persist voice preference to workspace/.config/tts.json */
  async setVoice(voice: string): Promise<void> {
    this.configuredVoice = voice;
    const configPath = join(this.configDir, 'tts.json');
    const { writeFile } = await import('fs/promises');
    await writeFile(configPath, JSON.stringify({ voice }, null, 2));
  }

  /** Get the currently active voice (configured or default) */
  getActiveVoice(): string {
    return this.configuredVoice || this.defaultVoice;
  }

  isAvailable(): boolean {
    return this.piperAvailable === true;
  }

  /**
   * Generate audio from text using Piper TTS.
   * Returns the file path of the generated audio.
   */
  async generate(text: string, options: {
    voice?: string;
    format?: 'wav' | 'ogg';
  } = {}): Promise<TTSResult> {
    if (!this.piperAvailable) {
      return {
        success: false,
        error: 'TTS not available. Install Piper TTS: pipx install piper-tts (or pip3 install piper-tts)',
      };
    }

    const voice = options.voice || this.configuredVoice || this.defaultVoice;
    const format = options.format || 'wav';
    const id = randomBytes(6).toString('hex');
    const wavFile = join(this.audioDir, `tts-${id}.wav`);
    const outputFile = format === 'ogg'
      ? join(this.audioDir, `tts-${id}.ogg`)
      : wavFile;

    try {
      // Sanitize text for shell (escape single quotes, limit length)
      const sanitized = text
        .replace(/'/g, "'\\''")
        .substring(0, 5000); // Limit to ~5000 chars (~5 min audio)

      // Generate WAV with Piper (using resolved full path)
      // --data-dir and --download-dir let piper auto-download voice models
      const voiceDir = join(process.env.HOME || '/tmp', '.local', 'share', 'piper-voices');
      const piperCmd = `echo '${sanitized}' | "${this.piperPath}" --model ${voice} --data-dir "${voiceDir}" --download-dir "${voiceDir}" --output_file "${wavFile}"`;
      await execAsync(piperCmd, { timeout: 120000 }); // 2 min timeout

      // Convert to OGG if requested (for Telegram voice messages)
      if (format === 'ogg' && this.ffmpegAvailable) {
        const ffmpegCmd = `"${this.ffmpegPath}" -y -i "${wavFile}" -c:a libopus -b:a 64k "${outputFile}"`;
        await execAsync(ffmpegCmd, { timeout: 60000 });
        // Clean up WAV
        try { await unlink(wavFile); } catch { /* ok */ }
      } else if (format === 'ogg' && !this.ffmpegAvailable) {
        // Fall back to WAV if ffmpeg not available
        return {
          success: true,
          file: wavFile,
          filename: `tts-${id}.wav`,
          format: 'wav',
          size: (await stat(wavFile)).size,
        };
      }

      const fileStats = await stat(outputFile);
      return {
        success: true,
        file: outputFile,
        filename: `tts-${id}.${format}`,
        format,
        size: fileStats.size,
      };
    } catch (error) {
      return {
        success: false,
        error: `TTS generation failed: ${String(error)}`,
      };
    }
  }

  /**
   * Get the raw audio file buffer for sending via Telegram.
   */
  async getAudioBuffer(filePath: string): Promise<Buffer | null> {
    try {
      return await readFile(filePath);
    } catch {
      return null;
    }
  }

  /**
   * List installed Piper voice models.
   */
  async listVoices(): Promise<TTSVoice[]> {
    if (!this.piperAvailable) return [];

    // Check common voice model locations
    const voiceDirs = [
      join(process.env.HOME || '', '.local', 'share', 'piper-voices'),
      '/usr/share/piper-voices',
      join(this.audioDir, '..', 'piper-voices'),
    ];

    const voices: TTSVoice[] = [];

    for (const dir of voiceDirs) {
      if (!existsSync(dir)) continue;
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          const name = String(entry);
          if (name.endsWith('.onnx')) {
            const voiceName = name.replace('.onnx', '').replace(/\//g, '-');
            const parts = voiceName.split('-');
            voices.push({
              name: voiceName,
              language: parts.slice(0, 2).join('-'),
              quality: parts[parts.length - 1] || 'medium',
            });
          }
        }
      } catch { /* dir not readable */ }
    }

    // Always include default voice (Piper can auto-download)
    if (voices.length === 0) {
      voices.push({
        name: this.defaultVoice,
        language: 'en_US',
        quality: 'medium',
      });
    }

    return voices;
  }

  /**
   * Clean up old audio files (older than 24 hours).
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    try {
      const files = await readdir(this.audioDir);
      for (const file of files) {
        if (!file.startsWith('tts-')) continue;
        const filePath = join(this.audioDir, file);
        try {
          const stats = await stat(filePath);
          if (stats.mtimeMs < cutoff) {
            await unlink(filePath);
            cleaned++;
          }
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist yet */ }

    return cleaned;
  }

  getAudioDir(): string {
    return this.audioDir;
  }
}
