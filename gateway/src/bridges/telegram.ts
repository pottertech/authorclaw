/**
 * AuthorClaw Telegram Bridge
 * Secure Telegram bot integration — acts as a command center
 * Users give orders via Telegram, AuthorClaw executes in the VM
 */

interface TelegramConfig {
  allowedUsers: string[];
  pairingEnabled: boolean;
}

/** Handler for direct commands that interact with gateway services */
interface CommandHandlers {
  createGoal: (title: string, description: string) => Promise<{ id: string; steps: number }>;
  startAndRunGoal: (goalId: string) => Promise<{ completed: string; response: string; wordCount: number; nextStep?: string } | { error: string }>;
  autoRunGoal: (goalId: string, statusCallback: (msg: string) => Promise<void>) => Promise<void>;
  listGoals: () => Array<{ id: string; title: string; status: string; progress: string }>;
  saveToFile: (filename: string, content: string) => Promise<void>;
  handleMessage: (content: string, channel: string, respond: (text: string) => void) => Promise<void>;
  research: (query: string) => Promise<{ results: string; error?: string }>;
  listFiles: (subdir?: string) => Promise<string[]>;
  readFile: (filename: string) => Promise<{ content: string; error?: string }>;
}

export class TelegramBridge {
  private token: string;
  private config: TelegramConfig;
  private pollingInterval: ReturnType<typeof setInterval> | null = null; // Legacy compat
  private polling = false;
  private messageHandler?: (content: string, channel: string, respond: (text: string) => void) => Promise<void>;
  private commandHandlers?: CommandHandlers;
  private lastUpdateId = 0;
  public pauseRequested = false;
  private knownChatIds: Set<number> = new Set(); // Track chat IDs for broadcasting
  private lastFileList: string[] = []; // For /read # file picker

  constructor(token: string, config: Partial<TelegramConfig>) {
    this.token = token;
    this.config = {
      allowedUsers: config.allowedUsers || [],
      pairingEnabled: config.pairingEnabled ?? true,
    };
  }

  onMessage(handler: (content: string, channel: string, respond: (text: string) => void) => Promise<void>) {
    this.messageHandler = handler;
  }

  /** Set command handlers for direct gateway interaction */
  setCommandHandlers(handlers: CommandHandlers) {
    this.commandHandlers = handlers;
  }

  async connect(): Promise<void> {
    // Verify bot token
    const response = await fetch(`https://api.telegram.org/bot${this.token}/getMe`);
    if (!response.ok) {
      throw new Error('Invalid Telegram bot token');
    }

    // Start sequential polling (not setInterval — prevents duplicate message processing)
    this.polling = true;
    this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      await this.poll();
      // Small delay between polls to prevent tight loops on errors
      if (this.polling) await new Promise(r => setTimeout(r, 500));
    }
  }

  private async poll(): Promise<void> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000); // slightly longer than Telegram timeout

      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`,
        { signal: controller.signal }
      );
      clearTimeout(timer);

      const data = await response.json() as any;

      for (const update of data.result || []) {
        this.lastUpdateId = update.update_id;
        const message = update.message;
        if (!message?.text) continue;

        const userId = String(message.from.id);
        const chatId = message.chat.id;
        const userName = message.from.first_name || 'there';

        // Check if user is allowed
        if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(userId)) {
          await this.sendMessage(chatId,
            '🔒 Not authorized. Ask the owner to add your ID (' + userId + ') in the dashboard.');
          continue;
        }

        // Track chat ID for broadcasting (only for allowed users)
        this.knownChatIds.add(chatId);

        // Route to appropriate handler
        await this.handleInput(chatId, message.text, userName);
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') return; // Normal timeout, just retry
      console.error('Telegram poll error:', error);
    }
  }

  private async handleInput(chatId: number, text: string, userName: string): Promise<void> {

    // ── /start and /help ──
    if (text.startsWith('/start') || text.startsWith('/help')) {
      await this.sendMessage(chatId,
        `✍️ Hey ${userName}! I'm AuthorClaw.\n\n` +
        `Tell me what to do and I'll figure out the steps.\n\n` +
        `*Commands:*\n` +
        `/conductor — Launch the book conductor\n` +
        `/goal [task] — Plan & auto-execute a task\n` +
        `/write [idea] — Plan & write a book\n` +
        `/goals — List all goals\n` +
        `/status — Status (conductor + goals)\n` +
        `/research [topic] — Research a topic\n` +
        `/files — List files (numbered)\n` +
        `/read [# or name] — Read a file\n` +
        `/speak [text] — Text-to-speech voice\n` +
        `/stop — Stop everything\n` +
        `/stop goal — Stop goal only\n` +
        `/stop conductor — Stop conductor only\n\n` +
        `Or just chat with me.`);
      return;
    }

    // ── /conductor — Launch the book conductor pipeline ──
    if (text.startsWith('/conductor')) {
      try {
        // Check if already running
        const runningRes = await fetch('http://localhost:3847/api/conductor/running');
        const runningData = await runningRes.json() as any;
        if (runningData.running) {
          await this.sendMessage(chatId, `🎼 Conductor is already running (PID: ${runningData.pid}).\nUse /stop to shut it down, or check the dashboard Live Progress tab.`);
          return;
        }

        await this.sendMessage(chatId, `🎼 Launching the book conductor...\nIt will write your configured project through all phases: premise → book bible → outline → writing → revision → assembly.`);

        const launchRes = await fetch('http://localhost:3847/api/conductor/launch', { method: 'POST' });
        const launchData = await launchRes.json() as any;

        if (launchData.success) {
          await this.sendMessage(chatId, `✅ Conductor launched (PID: ${launchData.pid})!\n\n📊 Watch progress: http://localhost:3847 → Live Progress tab\nUse /stop to halt it gracefully.`);
        } else {
          await this.sendMessage(chatId, `❌ ${launchData.error || 'Failed to launch conductor'}`);
        }
      } catch (e) {
        await this.sendMessage(chatId, `❌ Could not reach AuthorClaw: ${String(e)}`);
      }
      return;
    }

    // ── /write — Create a writing goal and AUTO-RUN all steps ──
    if (text.startsWith('/write')) {
      const idea = text.replace(/^\/write\s*/, '').trim();
      if (!idea) {
        await this.sendMessage(chatId, `What's the idea? Try:\n/write cyberpunk heist thriller about rogue AI`);
        return;
      }

      if (this.commandHandlers) {
        await this.sendMessage(chatId, `📝 On it. Planning "${idea}"...\nI'll figure out the steps and run them automatically.`);
        try {
          const goal = await this.commandHandlers.createGoal(idea, `Write a book: ${idea}`);
          await this.sendMessage(chatId, `✅ Planned ${goal.steps} steps. Running autonomously...`);

          // Auto-run ALL steps
          await this.commandHandlers.autoRunGoal(goal.id, async (msg) => {
            await this.sendMessage(chatId, msg);
          });
        } catch (e) {
          await this.sendMessage(chatId, `❌ Error: ${String(e)}`);
        }
      }
      return;
    }

    // ── /goals — List active goals (MUST be before /goal to avoid parsing as "/goal s") ──
    if (text === '/goals' || text.startsWith('/goals ')) {
      if (this.commandHandlers) {
        const goals = this.commandHandlers.listGoals();
        if (goals.length === 0) {
          await this.sendMessage(chatId, `No goals yet. Create one with /goal or /write`);
        } else {
          const list = goals.map(g =>
            `${g.status === 'completed' ? '✅' : g.status === 'active' ? '🔄' : g.status === 'failed' ? '❌' : '⏸'} ${g.title} (${g.progress})`
          ).join('\n');
          await this.sendMessage(chatId, `📋 *Goals:*\n${list}`);
        }
      }
      return;
    }

    // ── /goal — Create ANY goal and AUTO-RUN all steps ──
    if (text.startsWith('/goal ') || text === '/goal') {
      const description = text.replace(/^\/goal\s*/, '').trim();
      if (!description) {
        await this.sendMessage(chatId,
          `📋 Tell me what to do:\n` +
          `/goal write a full tech-thriller from start to finish\n` +
          `/goal research medieval weapons for my fantasy novel\n` +
          `/goal revise chapters 1-3 for pacing\n` +
          `/goal create marketing materials for my book`);
        return;
      }

      if (this.commandHandlers) {
        try {
          await this.sendMessage(chatId, `🧠 Planning "${description}"...`);
          const goal = await this.commandHandlers.createGoal(description, description);
          await this.sendMessage(chatId,
            `✅ Planned ${goal.steps} steps. Running autonomously...`);

          // Auto-run ALL steps
          await this.commandHandlers.autoRunGoal(goal.id, async (msg) => {
            await this.sendMessage(chatId, msg);
          });
        } catch (e) {
          await this.sendMessage(chatId, `❌ ${String(e)}`);
        }
      }
      return;
    }

    // ── /status — Quick status (includes conductor + goals) ──
    if (text.startsWith('/status')) {
      let summary = '';

      // Check conductor status
      try {
        const condRes = await fetch('http://localhost:3847/api/conductor/status');
        const cond = await condRes.json() as any;
        if (cond.phase && cond.phase !== 'idle') {
          summary += `🎼 *Conductor:* ${cond.phase}\n`;
          if (cond.step) summary += `   ${cond.step}\n`;
          if (cond.progress) {
            const p = cond.progress;
            if (p.chaptersComplete > 0) {
              summary += `   📖 ${p.chaptersComplete}/${p.totalChapters || 25} chapters`;
              if (p.wordCount) summary += ` (${Number(p.wordCount).toLocaleString()} words)`;
              summary += '\n';
            }
            if (p.elapsedMs) {
              summary += `   ⏱ ${Math.round(p.elapsedMs / 60000)} min elapsed\n`;
            }
          }
        }
      } catch { /* conductor endpoint unavailable */ }

      // Check goal engine status
      if (this.commandHandlers) {
        const goals = this.commandHandlers.listGoals();
        const active = goals.filter(g => g.status === 'active');
        const completed = goals.filter(g => g.status === 'completed');

        if (active.length > 0) {
          summary += `🔄 ${active.length} goal(s) running:\n` + active.map(g => `  • ${g.title} (${g.progress})`).join('\n') + '\n';
        }
        if (completed.length > 0) {
          summary += `✅ ${completed.length} goal(s) done\n`;
        }
      }

      if (!summary) summary = 'Nothing running. Use /goal or /conductor to start.\n';
      await this.sendMessage(chatId, summary + `\n📊 Dashboard: http://localhost:3847`);
      return;
    }

    // ── /research — Fetch from whitelisted domains ──
    if (text.startsWith('/research')) {
      const query = text.replace(/^\/research\s*/, '').trim();
      if (!query) {
        await this.sendMessage(chatId, `What should I research?\n/research medieval sword types\n/research self-publishing trends 2026`);
        return;
      }
      if (this.commandHandlers) {
        await this.sendMessage(chatId, `🔍 Researching "${query}"...`);
        try {
          const result = await this.commandHandlers.research(query);
          if (result.error) {
            await this.sendMessage(chatId, `⚠️ ${result.error}`);
          } else {
            await this.sendMessage(chatId, result.results);
          }
        } catch (e) {
          await this.sendMessage(chatId, `❌ Research failed: ${String(e)}`);
        }
      }
      return;
    }

    // ── /files — List project files with NUMBERED list for easy /read ──
    if (text.startsWith('/files')) {
      const subdir = text.replace(/^\/files\s*/, '').trim() || '';
      if (this.commandHandlers) {
        try {
          const files = await this.commandHandlers.listFiles(subdir);
          if (files.length === 0) {
            await this.sendMessage(chatId, `📁 No files found${subdir ? ` in ${subdir}` : ''}.\n\nFiles are saved to workspace/projects/ when you use /goal or /write.\nResearch goes to workspace/research/.`);
          } else {
            // Store file list for /read # selection
            this.lastFileList = files
              .filter(f => !f.includes('📁'))  // Only actual files, not directories
              .map(f => f.replace(/^[\s📄]+/, '').trim());

            let msg = `📁 *Files${subdir ? ` in ${subdir}` : ''}:*\n`;
            let fileNum = 1;
            for (const f of files) {
              if (f.includes('📁')) {
                msg += `\n${f}\n`;
              } else {
                msg += `  ${fileNum}. ${f.replace(/^[\s📄]+/, '').trim()}\n`;
                fileNum++;
              }
            }
            msg += `\n💡 Use /read 1 or /read 3 to read by number`;
            await this.sendMessage(chatId, msg);
          }
        } catch (e) {
          await this.sendMessage(chatId, `❌ ${String(e)}`);
        }
      }
      return;
    }

    // ── /read — Read a file by NUMBER or name ──
    if (text.startsWith('/read')) {
      const input = text.replace(/^\/read\s*/, '').trim();
      if (!input) {
        await this.sendMessage(chatId, `📖 Use /files first to see numbered list, then:\n/read 1 — read file #1\n/read 3 — read file #3\n\nOr use full name:\n/read projects/my-book/premise.md`);
        return;
      }

      if (this.commandHandlers) {
        try {
          // Check if input is a number (file picker)
          let filename = input;
          const num = parseInt(input, 10);
          if (!isNaN(num) && this.lastFileList && num >= 1 && num <= this.lastFileList.length) {
            filename = this.lastFileList[num - 1];
          }

          const result = await this.commandHandlers.readFile(filename);
          if (result.error) {
            await this.sendMessage(chatId, `⚠️ ${result.error}\n\n💡 Use /files first, then /read 1 to read by number.`);
          } else {
            const preview = result.content.length > 2000
              ? result.content.substring(0, 2000) + `\n\n... (${result.content.length} chars total — view full in dashboard)`
              : result.content;
            await this.sendMessage(chatId, `📄 *${filename}:*\n\n${preview}`);
          }
        } catch (e) {
          await this.sendMessage(chatId, `❌ ${String(e)}`);
        }
      }
      return;
    }

    // ── /speak — Text-to-speech via Piper (sends Telegram voice message) ──
    if (text.startsWith('/speak') || text.startsWith('/tts')) {
      const input = text.replace(/^\/(speak|tts)\s*/, '').trim();
      if (!input) {
        await this.sendMessage(chatId, `🔊 What should I read aloud?\n\n/speak The detective stepped into the library...\n/speak chapter 3 — reads chapter 3 aloud`);
        return;
      }

      try {
        // Check if TTS is available
        const statusRes = await fetch('http://localhost:3847/api/status');
        const status = await statusRes.json() as any;
        if (!status.tts?.available) {
          await this.sendMessage(chatId, `🔇 TTS not available yet. Install Piper TTS on the server:\n\`pip3 install piper-tts\``);
          return;
        }

        // Check if user wants to read a file (e.g., "/speak chapter 3")
        let textToSpeak = input;
        const chapterMatch = input.match(/^chapter\s+(\d+)/i);
        if (chapterMatch && this.commandHandlers) {
          const chapterNum = chapterMatch[1];
          // Try common chapter file patterns
          const patterns = [
            `chapters/chapter-${chapterNum}.md`,
            `chapters/chapter-${chapterNum.padStart(2, '0')}.md`,
            `chapters/ch${chapterNum}.md`,
          ];
          let found = false;
          for (const pattern of patterns) {
            try {
              const result = await this.commandHandlers.readFile(pattern);
              if (!result.error) {
                textToSpeak = result.content.substring(0, 5000); // Limit for TTS
                found = true;
                break;
              }
            } catch { /* try next pattern */ }
          }
          if (!found) {
            await this.sendMessage(chatId, `📄 Couldn't find chapter ${chapterNum}. Use /files to see available files.`);
            return;
          }
        }

        await this.sendMessage(chatId, `🔊 Generating audio...`);

        // Call TTS API
        const ttsRes = await fetch('http://localhost:3847/api/audio/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: textToSpeak, format: 'ogg' }),
        });
        const ttsData = await ttsRes.json() as any;

        if (ttsData.success && ttsData.file) {
          // Send as Telegram voice message
          await this.sendVoiceMessage(chatId, ttsData.file, textToSpeak.substring(0, 100));
        } else {
          await this.sendMessage(chatId, `❌ ${ttsData.error || 'TTS generation failed'}`);
        }
      } catch (e) {
        await this.sendMessage(chatId, `❌ TTS error: ${String(e)}`);
      }
      return;
    }

    // ── /stop — Stop conductor, goal, or both. Supports: /stop, /stop goal, /stop conductor ──
    if (text.startsWith('/stop') || text.startsWith('/pause')) {
      const arg = text.replace(/^\/(stop|pause)\s*/, '').trim().toLowerCase();
      let stoppedSomething = false;

      // Check what's running
      let conductorRunning = false;
      try {
        const runningRes = await fetch('http://localhost:3847/api/conductor/running');
        const runningData = await runningRes.json() as any;
        conductorRunning = runningData.running;
      } catch { /* silent */ }

      const activeGoal = this.commandHandlers
        ? this.commandHandlers.listGoals().find(g => g.status === 'active')
        : undefined;

      // Stop conductor (if requested or no specific target)
      if (conductorRunning && (arg === '' || arg === 'conductor' || arg === 'cond')) {
        await fetch('http://localhost:3847/api/conductor/stop', { method: 'POST' });
        await this.sendMessage(chatId, `🛑 Stop signal sent to conductor.`);
        stoppedSomething = true;
      }

      // Pause active goal (if requested or no specific target)
      if (activeGoal && (arg === '' || arg === 'goal' || arg === 'goals')) {
        await this.sendMessage(chatId, `⏸ Pausing "${activeGoal.title}"...`);
        this.pauseRequested = true;
        stoppedSomething = true;
      }

      if (!stoppedSomething) {
        if (arg === 'conductor' && !conductorRunning) {
          await this.sendMessage(chatId, `Conductor is not running.`);
        } else if (arg === 'goal' && !activeGoal) {
          await this.sendMessage(chatId, `No active goals to stop.`);
        } else {
          await this.sendMessage(chatId, `Nothing running right now.`);
        }
      }
      return;
    }

    // ── "continue" / "next" — Resume or run next step of a paused goal ──
    const lower = text.toLowerCase().trim();
    if (lower === 'continue' || lower === 'next' || lower === 'go' || lower === 'resume') {
      if (this.commandHandlers) {
        const goals = this.commandHandlers.listGoals();
        const active = goals.find(g => g.status === 'active' || g.status === 'paused');
        if (!active) {
          await this.sendMessage(chatId, `No goals to continue. Create one with /goal or /write`);
          return;
        }
        this.pauseRequested = false;
        await this.sendMessage(chatId, `▶️ Resuming "${active.title}"...`);
        try {
          await this.commandHandlers.autoRunGoal(active.id, async (msg) => {
            await this.sendMessage(chatId, msg);
          });
        } catch (e) {
          await this.sendMessage(chatId, `❌ ${String(e)}`);
        }
      }
      return;
    }

    // ── Regular message — send to AI with "be brief" instructions ──
    if (this.messageHandler) {
      await this.messageHandler(
        text,
        `telegram:${chatId}`,
        async (response) => {
          // Hard cap for regular Telegram messages (2000 chars) — prevents chapter dumps
          const MAX_TELEGRAM_RESPONSE = 2000;
          if (response.length > MAX_TELEGRAM_RESPONSE) {
            const truncated = response.substring(0, MAX_TELEGRAM_RESPONSE).replace(/\s+\S*$/, '');
            await this.sendMessage(chatId, truncated + '\n\n✂️ _Truncated. See full response in the dashboard._');
          } else {
            await this.sendMessage(chatId, response);
          }
        }
      );
    }
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    // Split long messages (Telegram limit: 4096 chars)
    const chunks = this.splitMessage(text, 4096);
    for (const chunk of chunks) {
      const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        }),
      });
      if (!response.ok) {
        // Retry without parse_mode in case Markdown formatting caused the error
        const retry = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
          }),
        });
        if (!retry.ok) {
          console.error('Telegram sendMessage failed:', await retry.text());
        }
      }
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt < maxLength / 2) splitAt = maxLength;
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt);
    }
    return chunks;
  }

  /**
   * Send a voice message (audio file) to a Telegram chat.
   * Used by /speak and /tts commands for text-to-speech output.
   */
  async sendVoiceMessage(chatId: number, filePath: string, caption?: string): Promise<void> {
    try {
      const { readFile } = await import('fs/promises');
      const audioBuffer = await readFile(filePath);
      const filename = filePath.endsWith('.ogg') ? 'voice.ogg' : 'voice.wav';

      // Build multipart form data manually for Telegram sendVoice API
      const boundary = '----TelegramVoice' + Date.now();
      const parts: Buffer[] = [];

      // Chat ID part
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));

      // Caption part (optional)
      if (caption) {
        const shortCaption = caption.length > 200 ? caption.substring(0, 200) + '...' : caption;
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n🔊 ${shortCaption}\r\n`));
      }

      // Voice file part
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="${filename}"\r\nContent-Type: ${filename.endsWith('.ogg') ? 'audio/ogg' : 'audio/wav'}\r\n\r\n`));
      parts.push(audioBuffer);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const response = await fetch(`https://api.telegram.org/bot${this.token}/sendVoice`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Telegram sendVoice failed:', errText);
        // Fall back to sending as document if voice fails
        await this.sendMessage(chatId, `🔊 Audio generated but couldn't send as voice message. File saved at: ${filePath}`);
      }
    } catch (error) {
      console.error('sendVoiceMessage error:', error);
      await this.sendMessage(chatId, `🔊 Audio generated at: ${filePath}\n(Voice sending failed: ${String(error)})`);
    }
  }

  /** Update allowed users on a live bridge (called when dashboard saves users) */
  updateAllowedUsers(users: string[]): void {
    this.config.allowedUsers = users;
  }

  /**
   * Broadcast a message to all known allowed users.
   * Used by autonomous heartbeat to send status updates.
   */
  async broadcastToAllowed(message: string): Promise<void> {
    for (const chatId of this.knownChatIds) {
      try {
        await this.sendMessage(chatId, message);
      } catch (e) {
        console.error(`Telegram broadcast to ${chatId} failed:`, e);
      }
    }
  }

  disconnect(): void {
    this.polling = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }
}
