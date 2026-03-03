/**
 * AuthorClaw Image Generation Service
 * Supports Together AI (Flux models) and OpenAI (GPT Image) for book cover generation.
 * Uses native fetch — no external dependencies.
 */

import { mkdir, writeFile, readdir, stat, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { Vault } from '../security/vault.js';

export interface ImageResult {
  success: boolean;
  file?: string;
  filename?: string;
  width?: number;
  height?: number;
  provider?: string;
  model?: string;
  error?: string;
}

export interface ImageGenOptions {
  provider?: 'together' | 'openai' | 'auto';
  width?: number;
  height?: number;
  style?: 'realistic' | 'illustrated' | 'minimalist';
}

export class ImageGenService {
  private imageDir: string;
  private vault: Vault;

  // Together AI models
  private static readonly TOGETHER_FREE = 'black-forest-labs/FLUX.1-schnell-Free';
  private static readonly TOGETHER_PRO = 'black-forest-labs/FLUX.1.1-pro';
  // OpenAI model
  private static readonly OPENAI_MODEL = 'gpt-image-1';

  constructor(workspaceDir: string, vault: Vault) {
    this.imageDir = join(workspaceDir, 'images');
    this.vault = vault;
  }

  async initialize(): Promise<void> {
    await mkdir(this.imageDir, { recursive: true });
  }

  /**
   * Check which image providers are available (have API keys)
   */
  async getAvailableProviders(): Promise<string[]> {
    const providers: string[] = [];
    const togetherKey = await this.vault.get('together_api_key');
    if (togetherKey) providers.push('together');
    const openaiKey = await this.vault.get('openai_api_key');
    if (openaiKey) providers.push('openai');
    return providers;
  }

  /**
   * Generate an image from a text prompt.
   * Tries Together AI first (cheaper), falls back to OpenAI.
   */
  async generate(prompt: string, options: ImageGenOptions = {}): Promise<ImageResult> {
    const width = options.width || 1024;
    const height = options.height || 1536; // Book cover ratio ~2:3
    const preferredProvider = options.provider || 'auto';

    // Add style prefix to prompt
    let styledPrompt = prompt;
    if (options.style === 'illustrated') {
      styledPrompt = `Digital illustration, vibrant colors, detailed artwork. ${prompt}`;
    } else if (options.style === 'minimalist') {
      styledPrompt = `Minimalist book cover design, clean typography space, simple elegant composition. ${prompt}`;
    } else if (options.style === 'realistic') {
      styledPrompt = `Photorealistic, cinematic lighting, high-detail. ${prompt}`;
    }

    // Try Together AI first (if requested or auto)
    if (preferredProvider === 'together' || preferredProvider === 'auto') {
      const result = await this.generateWithTogether(styledPrompt, width, height);
      if (result.success) return result;
      if (preferredProvider === 'together') return result; // Don't fallback if explicitly chosen
    }

    // Try OpenAI (if requested or auto-fallback)
    if (preferredProvider === 'openai' || preferredProvider === 'auto') {
      const result = await this.generateWithOpenAI(styledPrompt, width, height);
      if (result.success) return result;
      return result;
    }

    return { success: false, error: 'No image generation provider available. Add a Together AI or OpenAI API key in Settings.' };
  }

  /**
   * Generate a book cover image with smart prompting.
   */
  async generateBookCover(params: {
    title: string;
    author: string;
    genre: string;
    description: string;
    style?: 'realistic' | 'illustrated' | 'minimalist';
  }): Promise<ImageResult> {
    const coverPrompt = this.buildCoverPrompt(params);
    return this.generate(coverPrompt, {
      style: params.style || 'illustrated',
      width: 1024,
      height: 1536,
    });
  }

  // ── Together AI ──

  private async generateWithTogether(prompt: string, width: number, height: number): Promise<ImageResult> {
    const apiKey = await this.vault.get('together_api_key');
    if (!apiKey) {
      return { success: false, error: 'Together AI API key not configured' };
    }

    try {
      // Use free model first, fall back to pro
      const model = ImageGenService.TOGETHER_FREE;

      const response = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt,
          width: Math.min(width, 1440),
          height: Math.min(height, 1440),
          n: 1,
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(120000), // 2 min timeout for image gen
      });

      if (!response.ok) {
        const errText = await response.text();
        // If free model fails, try pro
        if (model === ImageGenService.TOGETHER_FREE) {
          console.log('[image-gen] Free model failed, trying pro model...');
          return this.generateWithTogetherPro(apiKey, prompt, width, height);
        }
        return { success: false, error: `Together AI error: ${response.status} ${errText.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) {
        return { success: false, error: 'Together AI returned empty image data' };
      }

      return this.saveImage(Buffer.from(b64, 'base64'), 'together', model, width, height);
    } catch (err) {
      return { success: false, error: `Together AI request failed: ${String(err)}` };
    }
  }

  private async generateWithTogetherPro(apiKey: string, prompt: string, width: number, height: number): Promise<ImageResult> {
    try {
      const response = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ImageGenService.TOGETHER_PRO,
          prompt,
          width: Math.min(width, 1440),
          height: Math.min(height, 1440),
          n: 1,
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `Together AI Pro error: ${response.status} ${errText.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) return { success: false, error: 'Together AI returned empty image data' };

      return this.saveImage(Buffer.from(b64, 'base64'), 'together', ImageGenService.TOGETHER_PRO, width, height);
    } catch (err) {
      return { success: false, error: `Together AI Pro request failed: ${String(err)}` };
    }
  }

  // ── OpenAI ──

  private async generateWithOpenAI(prompt: string, width: number, height: number): Promise<ImageResult> {
    const apiKey = await this.vault.get('openai_api_key');
    if (!apiKey) {
      return { success: false, error: 'OpenAI API key not configured' };
    }

    try {
      // Map dimensions to OpenAI supported sizes
      const size = this.getOpenAISize(width, height);

      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ImageGenService.OPENAI_MODEL,
          prompt,
          size,
          n: 1,
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `OpenAI error: ${response.status} ${errText.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      const b64 = data?.data?.[0]?.b64_json;
      if (!b64) return { success: false, error: 'OpenAI returned empty image data' };

      return this.saveImage(Buffer.from(b64, 'base64'), 'openai', ImageGenService.OPENAI_MODEL, width, height);
    } catch (err) {
      return { success: false, error: `OpenAI image request failed: ${String(err)}` };
    }
  }

  private getOpenAISize(width: number, height: number): string {
    // OpenAI supports specific sizes for gpt-image-1
    const ratio = width / height;
    if (ratio < 0.8) return '1024x1536'; // Portrait (book cover)
    if (ratio > 1.2) return '1536x1024'; // Landscape
    return '1024x1024'; // Square
  }

  // ── Shared ──

  private async saveImage(buffer: Buffer, provider: string, model: string, width: number, height: number): Promise<ImageResult> {
    const id = randomBytes(6).toString('hex');
    const filename = `cover-${id}.png`;
    const filePath = join(this.imageDir, filename);

    await writeFile(filePath, buffer);

    return {
      success: true,
      file: filePath,
      filename,
      width,
      height,
      provider,
      model,
    };
  }

  /**
   * Build a detailed book cover prompt from context.
   */
  private buildCoverPrompt(params: { title: string; author: string; genre: string; description: string }): string {
    const genreStyles: Record<string, string> = {
      'romance': 'warm tones, intimate atmosphere, elegant, soft lighting, couple silhouette or embrace',
      'fantasy': 'epic, magical, dramatic lighting, mystical elements, rich colors, castle or magical landscape',
      'sci-fi': 'futuristic, space, technology, neon accents, dark atmosphere, sleek design',
      'thriller': 'dark, moody, suspenseful, high contrast, shadow play, urban setting',
      'mystery': 'atmospheric, foggy, clues, dark palette, intrigue, vintage feel',
      'horror': 'dark, eerie, unsettling, dramatic shadows, sinister atmosphere',
      'literary': 'artistic, thoughtful, subtle, muted tones, symbolic imagery',
      'ya': 'vibrant, dynamic, energetic colors, bold composition, youthful',
      'nonfiction': 'clean, professional, authoritative, bold typography space, minimal imagery',
      'memoir': 'personal, warm, nostalgic, soft focus, intimate atmosphere',
      'children': 'colorful, playful, whimsical, bright, fun illustrations',
    };

    const genreKey = Object.keys(genreStyles).find(k => params.genre.toLowerCase().includes(k)) || 'literary';
    const genreStyle = genreStyles[genreKey];

    return `Professional book cover design for "${params.title}" by ${params.author}. ` +
      `Genre: ${params.genre}. ${genreStyle}. ` +
      `The cover should convey: ${params.description.slice(0, 300)}. ` +
      `Leave clear space at the top for the title and at the bottom for the author name. ` +
      `High quality, commercial book cover, suitable for Amazon KDP. No text on the image.`;
  }

  /**
   * Clean up old images (older than 7 days)
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

    try {
      const files = await readdir(this.imageDir);
      for (const file of files) {
        if (!String(file).startsWith('cover-')) continue;
        const filePath = join(this.imageDir, String(file));
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

  getImageDir(): string {
    return this.imageDir;
  }
}
