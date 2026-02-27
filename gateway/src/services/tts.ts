/**
 * AuthorClaw TTS Service
 * Text-to-speech using Piper TTS (local, free, MIT-licensed)
 *
 * Generates audio files from text. Supports WAV output and OGG conversion
 * for Telegram voice messages. Gracefully degrades if Piper is not installed.
 */

import { exec } from 'child_process';
import { mkdir, readdir, stat, readFile, unlink } from 'fs/promises';
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
  private piperAvailable: boolean | null = null;
  private ffmpegAvailable: boolean | null = null;
  private defaultVoice = 'en_US-lessac-medium';

  constructor(workspaceDir: string) {
    this.audioDir = join(workspaceDir, 'audio');
  }

  async initialize(): Promise<void> {
    // Create audio output directory
    await mkdir(this.audioDir, { recursive: true });

    // Check if Piper TTS is installed
    this.piperAvailable = await this.checkCommand('piper --help');

    // Check if ffmpeg is available (for OGG conversion)
    this.ffmpegAvailable = await this.checkCommand('ffmpeg -version');

    if (this.piperAvailable) {
      console.log('  🔊 TTS: Piper TTS available');
    } else {
      console.log('  🔇 TTS: Piper not installed (install with: pip3 install piper-tts)');
    }
  }

  private async checkCommand(cmd: string): Promise<boolean> {
    try {
      await execAsync(cmd, { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
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
        error: 'TTS not available. Install Piper TTS: pip3 install piper-tts',
      };
    }

    const voice = options.voice || this.defaultVoice;
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

      // Generate WAV with Piper
      const piperCmd = `echo '${sanitized}' | piper --model ${voice} --output_file "${wavFile}"`;
      await execAsync(piperCmd, { timeout: 120000 }); // 2 min timeout

      // Convert to OGG if requested (for Telegram voice messages)
      if (format === 'ogg' && this.ffmpegAvailable) {
        const ffmpegCmd = `ffmpeg -y -i "${wavFile}" -c:a libopus -b:a 64k "${outputFile}"`;
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
