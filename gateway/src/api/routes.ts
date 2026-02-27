/**
 * AuthorClaw API Routes
 * REST API for the dashboard and external integrations
 */

// NOTE: All endpoints are currently unauthenticated.
// This is acceptable because the server binds to 127.0.0.1 only (localhost).
// For remote access, implement Bearer token auth using the vault.

import { Application, Request, Response } from 'express';
import { ChildProcess, spawn } from 'child_process';

export function createAPIRoutes(app: Application, gateway: any, rootDir?: string): void {
  const services = gateway.getServices();
  const baseDir = rootDir || process.cwd();

  // In-memory conductor state (updated by conductor script, read by dashboard)
  let conductorState: any = { phase: 'idle', step: '', progress: {} };
  let conductorStopRequested = false;
  let conductorProcess: ChildProcess | null = null;

  // Tracking for Telegram notifications (avoid spamming — only notify on milestones)
  let previousConductorPhase = 'idle';
  let previousChaptersComplete = 0;

  // ── Health Check ──
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '2.0.0',
      name: 'AuthorClaw',
      brand: 'Writing Secrets',
      uptime: process.uptime(),
      links: {
        website: 'https://www.getwritingsecrets.com',
        kofi: 'https://ko-fi.com/s/4e24f1dfa5',
        youtube: 'https://www.youtube.com/@WritingSecrets',
      },
    });
  });

  // ── Status Dashboard ──
  app.get('/api/status', (_req: Request, res: Response) => {
    res.json({
      soul: services.soul.getName(),
      providers: services.aiRouter.getActiveProviders().map((p: any) => ({
        id: p.id, name: p.name, model: p.model, tier: p.tier,
      })),
      costs: services.costs.getStatus(),
      skills: {
        total: services.skills.getLoadedCount(),
        author: services.skills.getAuthorSkillCount(),
        premium: services.skills.getPremiumSkillCount(),
        premiumInstalled: services.skills.getPremiumSkills(),
        catalog: services.skills.getSkillCatalog(),
        byCategory: services.skills.getSkillsByCategory(),
      },
      heartbeat: services.heartbeat.getStats(),
      autonomous: services.heartbeat.getAutonomousStatus(),
      permissions: services.permissions.preset,
      cache: services.aiRouter.getCacheStats(),
      // TTS hidden from status (feature removed from UI)
    });
  });

  // ── Chat API (for integrations) ──
  app.post('/api/chat', async (req: Request, res: Response) => {
    const { message, skipHistory } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message required' });
    }
    if (message.length > 10000) {
      return res.status(400).json({ error: 'Message too long (max 10,000 chars)' });
    }

    // Use 'conductor' channel when skipHistory is set (prevents chapter dumps in Telegram)
    const channel = skipHistory ? 'conductor' : 'api';
    let response = '';
    try {
      await gateway.handleMessage(message, channel, (text: string) => {
        response = text;
      });
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes('No AI providers')) {
        return res.status(503).json({ error: 'No AI providers configured. Add an API key in Settings → API Keys.' });
      }
      return res.status(500).json({ error: 'AI error: ' + msg });
    }

    res.json({ response });
  });

  // ── Project Management ──
  app.get('/api/projects', async (_req: Request, res: Response) => {
    const { readdir } = await import('fs/promises');
    const { existsSync } = await import('fs');
    const { join } = await import('path');

    const projectsDir = join(baseDir, 'workspace', 'projects');
    if (!existsSync(projectsDir)) {
      return res.json({ projects: [] });
    }

    const entries = await readdir(projectsDir, { withFileTypes: true });
    const projects = entries.filter(e => e.isDirectory() && e.name !== '.template').map(e => e.name);
    res.json({ projects });
  });

  // ── Cost Report ──
  app.get('/api/costs', (_req: Request, res: Response) => {
    res.json(services.costs.getStatus());
  });

  // ── Audit Log (last 50 entries) ──
  app.get('/api/audit', async (_req: Request, res: Response) => {
    const { readFile } = await import('fs/promises');
    const { existsSync } = await import('fs');
    const { join } = await import('path');

    const today = new Date().toISOString().split('T')[0];
    const logFile = join(baseDir, 'workspace', '.audit', `${today}.jsonl`);

    if (!existsSync(logFile)) {
      return res.json({ entries: [] });
    }

    const raw = await readFile(logFile, 'utf-8');
    const entries = raw.trim().split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).slice(-50);

    res.json({ entries });
  });

  // ═══════════════════════════════════════════════════════════
  // Activity Log (universal agent action feed)
  // ═══════════════════════════════════════════════════════════

  // Get recent activity entries
  app.get('/api/activity', async (req: Request, res: Response) => {
    const activityLog = gateway.getActivityLog?.();
    if (!activityLog) {
      return res.json({ entries: [] });
    }
    const count = Number(req.query.count) || 50;
    const goalId = req.query.goalId as string | undefined;
    const entries = await activityLog.getRecent(count, goalId);
    res.json({ entries });
  });

  // SSE stream for real-time activity updates
  app.get('/api/activity/stream', (req: Request, res: Response) => {
    const activityLog = gateway.getActivityLog?.();
    if (!activityLog) {
      return res.status(503).json({ error: 'Activity log not initialized' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial heartbeat
    res.write('data: {"type":"connected"}\n\n');

    // Register this client for live updates
    const cleanup = activityLog.addSSEClient(res);

    // Clean up on disconnect
    req.on('close', cleanup);
  });

  // ═══════════════════════════════════════════════════════════
  // Memory Management
  // ═══════════════════════════════════════════════════════════

  app.post('/api/memory/reset', async (req: Request, res: Response) => {
    const fullReset = req.query.full === 'true' || req.body?.full === true;
    try {
      const result = await services.memory.reset(fullReset);
      await services.audit.log('memory', 'reset', { fullReset, cleared: result.cleared });
      res.json({ success: true, ...result, fullReset });
    } catch (error) {
      res.status(500).json({ error: 'Failed to reset memory: ' + String(error) });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Vault Management (for dashboard API key configuration)
  // ═══════════════════════════════════════════════════════════

  // Store a key in the encrypted vault
  app.post('/api/vault', async (req: Request, res: Response) => {
    const { key, value } = req.body;
    if (!key || !value) {
      return res.status(400).json({ error: 'key and value required' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      return res.status(400).json({ error: 'Invalid key name. Use only letters, numbers, underscores, and hyphens.' });
    }
    try {
      await services.vault.set(key, value);
      await services.audit.log('vault', 'key_stored', { key });

      // Auto-refresh AI providers when an API key is stored
      const apiKeyNames = ['gemini_api_key', 'deepseek_api_key', 'anthropic_api_key', 'openai_api_key'];
      let refreshedProviders: string[] | undefined;
      if (apiKeyNames.includes(key)) {
        refreshedProviders = await services.aiRouter.reinitialize();
      }

      res.json({ success: true, key, refreshedProviders });
    } catch (error) {
      res.status(500).json({ error: 'Failed to store key' });
    }
  });

  // Manually refresh AI provider detection
  app.post('/api/providers/refresh', async (_req: Request, res: Response) => {
    try {
      const providers = await services.aiRouter.reinitialize();
      res.json({
        success: true,
        providers: services.aiRouter.getActiveProviders().map((p: any) => ({
          id: p.id, name: p.name, model: p.model, tier: p.tier,
        })),
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to refresh providers: ' + String(error) });
    }
  });

  // Load API keys from text files in the VM shared folder
  app.post('/api/vault/load-from-files', async (req: Request, res: Response) => {
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const { join: j } = await import('path');

    // Check common shared folder locations (VM, Docker, or user-set env var)
    const candidates = [
      process.env.AUTHORCLAW_KEYS_DIR,
      '/media/sf_authorclaw-transfer',
      '/media/sf_vm-transfer',
      j(baseDir, '..', 'vm-transfer'),
    ].filter(Boolean) as string[];
    const sharedFolder = candidates.find(p => ex(p));
    if (!sharedFolder) {
      return res.status(404).json({ error: 'No key folder found. Add API keys manually in Settings above.' });
    }

    const keyFiles: Record<string, string> = {
      'gemini_api_key': 'gemini_api_key.txt',
      'deepseek_api_key': 'deepseek_api_key.txt',
      'anthropic_api_key': 'anthropic_api_key.txt',
      'openai_api_key': 'openai_api_key.txt',
      'telegram_bot_token': 'telegram_bot_token.txt',
    };

    const loaded: string[] = [];
    const errors: string[] = [];

    for (const [vaultKey, filename] of Object.entries(keyFiles)) {
      const filePath = j(sharedFolder, filename);
      if (ex(filePath)) {
        try {
          const value = (await rf(filePath, 'utf-8')).trim();
          if (value && value.length > 5) {
            await services.vault.set(vaultKey, value);
            await services.audit.log('vault', 'key_loaded_from_file', { key: vaultKey, file: filename });
            loaded.push(vaultKey);
          }
        } catch (e) {
          errors.push(`${filename}: ${String(e)}`);
        }
      }
    }

    // Generic key.txt fallback
    const fallbackKey = req.body?.fallbackKeyName || 'gemini_api_key';
    const genericPath = j(sharedFolder, 'key.txt');
    if (ex(genericPath) && !loaded.includes(fallbackKey)) {
      try {
        const value = (await rf(genericPath, 'utf-8')).trim();
        if (value && value.length > 5) {
          await services.vault.set(fallbackKey, value);
          await services.audit.log('vault', 'key_loaded_from_file', { key: fallbackKey, file: 'key.txt' });
          loaded.push(fallbackKey + ' (from key.txt)');
        }
      } catch (e) {
        errors.push(`key.txt: ${String(e)}`);
      }
    }

    // Re-initialize AI providers if any API keys were loaded
    const apiKeyNames = ['gemini_api_key', 'deepseek_api_key', 'anthropic_api_key', 'openai_api_key'];
    if (loaded.some(k => apiKeyNames.some(ak => k.startsWith(ak)))) {
      await services.aiRouter.reinitialize();
    }

    res.json({ loaded, errors, message: loaded.length > 0 ? `Loaded ${loaded.length} key(s)` : 'No key files found in shared folder' });
  });

  // List stored key names (never values)
  app.get('/api/vault/keys', async (_req: Request, res: Response) => {
    const keys = await services.vault.list();
    res.json({ keys });
  });

  // Delete a key from the vault
  app.delete('/api/vault/:key', async (req: Request, res: Response) => {
    const deleted = await services.vault.delete(req.params.key);
    if (deleted) {
      await services.audit.log('vault', 'key_deleted', { key: req.params.key });
    }
    res.json({ success: deleted });
  });

  // ═══════════════════════════════════════════════════════════
  // Config (sanitized, read-only for dashboard)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      ai: services.config.get('ai'),
      heartbeat: services.config.get('heartbeat'),
      costs: services.config.get('costs'),
      security: { permissionPreset: services.config.get('security.permissionPreset') },
    });
  });

  // Update a single config value (for dashboard settings)
  app.post('/api/config/update', (req: Request, res: Response) => {
    const { path, value } = req.body;
    if (!path) return res.status(400).json({ error: 'path required' });
    const safePaths = [
      'costs.dailyLimit', 'costs.monthlyLimit',
      'heartbeat.intervalMinutes', 'heartbeat.dailyWordGoal',
      'heartbeat.enableReminders', 'heartbeat.quietHoursStart',
      'heartbeat.quietHoursEnd', 'heartbeat.autonomousEnabled',
      'heartbeat.autonomousIntervalMinutes', 'heartbeat.maxAutonomousStepsPerWake',
      'ai.defaultTemperature',
      'ai.ollama.enabled', 'ai.ollama.endpoint', 'ai.ollama.model',
      'bridges.telegram.enabled', 'bridges.telegram.pairingEnabled',
    ];
    if (!safePaths.includes(path)) {
      return res.status(403).json({ error: 'Config path not allowed' });
    }
    services.config.set(path, value);
    res.json({ success: true, path, value });
  });

  // ═══════════════════════════════════════════════════════════
  // Telegram Bridge Management (dashboard integration)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/telegram/status', async (_req: Request, res: Response) => {
    const enabled = services.config.get('bridges.telegram.enabled', false);
    const hasToken = (await services.vault.list()).includes('telegram_bot_token');
    const allowedUsers: string[] = services.config.get('bridges.telegram.allowedUsers', []);
    const connected = gateway.isTelegramConnected?.() || false;

    res.json({
      enabled,
      hasToken,
      connected,
      allowedUsers,
      pairingEnabled: services.config.get('bridges.telegram.pairingEnabled', true),
    });
  });

  app.post('/api/telegram/users', async (req: Request, res: Response) => {
    const { users } = req.body;
    if (!Array.isArray(users)) {
      return res.status(400).json({ error: 'users must be an array of user ID strings' });
    }
    const valid = users.every((u: any) => typeof u === 'string' && /^\d+$/.test(u));
    if (!valid) {
      return res.status(400).json({ error: 'Each user ID must be a numeric string' });
    }
    await services.config.setAndPersist('bridges.telegram.allowedUsers', users);
    gateway.updateTelegramUsers?.(users);
    res.json({ success: true, users });
  });

  app.post('/api/telegram/connect', async (_req: Request, res: Response) => {
    try {
      const result = await gateway.connectTelegram?.();
      if (result?.error) {
        return res.status(400).json({ error: result.error });
      }
      await services.config.setAndPersist('bridges.telegram.enabled', true);
      res.json({ success: true, message: 'Telegram bridge connected' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to connect Telegram: ' + String(error) });
    }
  });

  app.post('/api/telegram/disconnect', async (_req: Request, res: Response) => {
    gateway.disconnectTelegram?.();
    await services.config.setAndPersist('bridges.telegram.enabled', false);
    res.json({ success: true, message: 'Telegram bridge disconnected' });
  });

  app.post('/api/telegram/test', async (req: Request, res: Response) => {
    const token = req.body.token || await services.vault.get('telegram_bot_token');
    if (!token) {
      return res.status(400).json({ error: 'No token provided or stored' });
    }
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await response.json() as any;
      if (data.ok) {
        res.json({ success: true, bot: { username: data.result.username, name: data.result.first_name } });
      } else {
        res.status(400).json({ error: data.description || 'Invalid token' });
      }
    } catch (error) {
      res.status(500).json({ error: 'Failed to test token: ' + String(error) });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Goal Engine (autonomous goal-based task planning)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/goals/templates', async (_req: Request, res: Response) => {
    const goals = gateway.getGoalEngine?.();
    if (!goals) {
      return res.status(503).json({ error: 'Goal engine not initialized' });
    }
    // Merge built-in templates with custom templates
    const builtIn = goals.getTemplates();
    const { join: j } = await import('path');
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const customPath = j(baseDir, 'workspace', '.config', 'custom-goal-templates.json');
    let custom: any[] = [];
    if (ex(customPath)) {
      try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    }
    const customMapped = custom.map((t: any) => ({
      ...t, label: t.title, stepCount: 0, custom: true,
    }));
    res.json({ templates: [...builtIn, ...customMapped] });
  });

  // Save a custom goal template
  app.post('/api/goals/templates', async (req: Request, res: Response) => {
    const { title, description, type } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }
    const { join: j } = await import('path');
    const { readFile: rf, writeFile: wf, mkdir: mkd } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const { randomBytes } = await import('crypto');
    const configDir = j(baseDir, 'workspace', '.config');
    await mkd(configDir, { recursive: true });
    const customPath = j(configDir, 'custom-goal-templates.json');
    let custom: any[] = [];
    if (ex(customPath)) {
      try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    }
    custom.push({ id: randomBytes(6).toString('hex'), title, description, type: type || 'general', createdAt: new Date().toISOString() });
    await wf(customPath, JSON.stringify(custom, null, 2));
    res.json({ success: true });
  });

  // Delete a custom goal template
  app.delete('/api/goals/templates/:id', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readFile: rf, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const customPath = j(baseDir, 'workspace', '.config', 'custom-goal-templates.json');
    if (!ex(customPath)) {
      return res.json({ success: false, error: 'No custom templates' });
    }
    let custom: any[] = [];
    try { custom = JSON.parse(await rf(customPath, 'utf-8')); } catch { /* ok */ }
    custom = custom.filter((t: any) => t.id !== req.params.id);
    await wf(customPath, JSON.stringify(custom, null, 2));
    res.json({ success: true });
  });

  // Create a new goal — supports dynamic AI planning
  app.post('/api/goals', async (req: Request, res: Response) => {
    const goals = gateway.getGoalEngine?.();
    if (!goals) {
      return res.status(503).json({ error: 'Goal engine not initialized' });
    }
    const { type, title, description, context, planning } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }

    // Dynamic planning: ask the AI to figure out the steps
    if (planning === 'dynamic') {
      const skillCatalog = services.skills.getSkillCatalog();
      const authorOSTools = services.authorOS?.getAvailableTools() || [];
      const goal = await goals.planGoal(title, description, skillCatalog, authorOSTools, context);
      return res.json({ goal, planning: 'dynamic' });
    }

    // Template-based fallback
    const goalType = type || goals.inferGoalType(description);
    const goal = goals.createGoal(goalType, title, description, context);
    res.json({ goal, planning: 'template' });
  });

  app.get('/api/goals', (req: Request, res: Response) => {
    const goals = gateway.getGoalEngine?.();
    if (!goals) {
      return res.status(503).json({ error: 'Goal engine not initialized' });
    }
    const status = (req.query as any).status;
    res.json({ goals: goals.listGoals(status) });
  });

  app.get('/api/goals/:id', (req: Request, res: Response) => {
    const goals = gateway.getGoalEngine?.();
    if (!goals) {
      return res.status(503).json({ error: 'Goal engine not initialized' });
    }
    const goal = goals.getGoal(req.params.id);
    if (!goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }
    res.json({ goal });
  });

  app.post('/api/goals/:id/start', (req: Request, res: Response) => {
    const goals = gateway.getGoalEngine?.();
    if (!goals) {
      return res.status(503).json({ error: 'Goal engine not initialized' });
    }
    const step = goals.startGoal(req.params.id);
    if (!step) {
      return res.status(404).json({ error: 'Goal not found or no pending steps' });
    }
    res.json({ step, goal: goals.getGoal(req.params.id) });
  });

  app.post('/api/goals/:id/execute', async (req: Request, res: Response) => {
    const goalsEngine = gateway.getGoalEngine?.();
    if (!goalsEngine) {
      return res.status(503).json({ error: 'Goal engine not initialized' });
    }
    const goal = goalsEngine.getGoal(req.params.id);
    if (!goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    const activeStep = goal.steps.find((s: any) => s.status === 'active');
    if (!activeStep) {
      return res.status(400).json({ error: 'No active step. Start the goal first.' });
    }

    try {
      const goalContext = goalsEngine.buildGoalContext(goal, activeStep);
      let response = '';

      await gateway.handleMessage(
        activeStep.prompt,
        'goals',
        (text: string) => { response = text; },
        goalContext
      );

      if (!response || response.length < 50) {
        goalsEngine.failStep(goal.id, activeStep.id, 'Empty or too-short response from AI');
        return res.json({
          success: false,
          error: 'AI returned an insufficient response',
          goal: goalsEngine.getGoal(goal.id),
        });
      }

      const nextStep = goalsEngine.completeStep(goal.id, activeStep.id, response);

      res.json({
        success: true,
        completedStep: activeStep.id,
        response,
        nextStep,
        goal: goalsEngine.getGoal(goal.id),
      });
    } catch (error) {
      goalsEngine.failStep(goal.id, activeStep.id, String(error));
      res.status(500).json({
        error: 'Step execution failed: ' + String(error),
        goal: goalsEngine.getGoal(goal.id),
      });
    }
  });

  // Auto-execute ALL steps of a goal (fully autonomous mode)
  app.post('/api/goals/:id/auto-execute', async (req: Request, res: Response) => {
    const goalsEngine = gateway.getGoalEngine?.();
    if (!goalsEngine) {
      return res.status(503).json({ error: 'Goal engine not initialized' });
    }
    const goal = goalsEngine.getGoal(req.params.id);
    if (!goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    if (goal.status === 'pending') {
      goalsEngine.startGoal(req.params.id);
    } else if (goal.status === 'paused') {
      goal.status = 'active';
      const firstPending = goal.steps.find((s: any) => s.status === 'pending');
      if (firstPending) firstPending.status = 'active';
    }

    const results: Array<{ step: string; success: boolean; wordCount?: number; error?: string }> = [];
    const { join } = await import('path');
    const { mkdir, writeFile } = await import('fs/promises');
    const workspaceDir = join(baseDir, 'workspace');

    while (true) {
      const currentGoal = goalsEngine.getGoal(req.params.id);
      if (!currentGoal) break;

      // Check if goal was paused externally (via /stop or dashboard)
      if (currentGoal.status === 'paused' || currentGoal.status === 'completed') break;

      const activeStep = currentGoal.steps.find((s: any) => s.status === 'active');
      if (!activeStep) break;

      try {
        const goalContext = goalsEngine.buildGoalContext(currentGoal, activeStep);
        let response = '';

        await gateway.handleMessage(
          activeStep.prompt,
          'goal-engine',
          (text: string) => { response = text; },
          goalContext
        );

        if (!response || response.length < 50) {
          goalsEngine.failStep(currentGoal.id, activeStep.id, 'Empty or too-short response from AI');
          results.push({ step: activeStep.label, success: false, error: 'Insufficient AI response' });
          break;
        }

        const wordCount = response.split(/\s+/).length;

        // Save to file
        try {
          const projectDir = join(workspaceDir, 'projects', currentGoal.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
          await mkdir(projectDir, { recursive: true });
          const stepFileName = `${activeStep.id}-${activeStep.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
          await writeFile(join(projectDir, stepFileName), `# ${activeStep.label}\n\n${response}`, 'utf-8');
        } catch { /* non-fatal */ }

        goalsEngine.completeStep(currentGoal.id, activeStep.id, response);
        // Track words for Morning Briefing
        services.heartbeat.addWords(wordCount);
        results.push({ step: activeStep.label, success: true, wordCount });

        // Re-check pause AFTER step completes (catches /stop sent during long AI call)
        const freshGoal = goalsEngine.getGoal(req.params.id);
        if (freshGoal?.status === 'paused' || freshGoal?.status === 'completed') break;
      } catch (error) {
        goalsEngine.failStep(currentGoal.id, activeStep.id, String(error));
        results.push({ step: activeStep.label, success: false, error: String(error) });
        break;
      }
    }

    res.json({
      success: true,
      results,
      goal: goalsEngine.getGoal(req.params.id),
    });
  });

  app.post('/api/goals/:id/skip/:stepId', (req: Request, res: Response) => {
    const goals = gateway.getGoalEngine?.();
    if (!goals) {
      return res.status(503).json({ error: 'Goal engine not initialized' });
    }
    const nextStep = goals.skipStep(req.params.id, req.params.stepId);
    res.json({ nextStep, goal: goals.getGoal(req.params.id) });
  });

  app.post('/api/goals/:id/pause', (req: Request, res: Response) => {
    const goals = gateway.getGoalEngine?.();
    if (!goals) {
      return res.status(503).json({ error: 'Goal engine not initialized' });
    }
    goals.pauseGoal(req.params.id);
    res.json({ goal: goals.getGoal(req.params.id) });
  });

  app.delete('/api/goals/:id', (req: Request, res: Response) => {
    const goals = gateway.getGoalEngine?.();
    if (!goals) {
      return res.status(503).json({ error: 'Goal engine not initialized' });
    }
    const deleted = goals.deleteGoal(req.params.id);
    res.json({ success: deleted });
  });

  // ═══════════════════════════════════════════════════════════
  // Autonomous Heartbeat Mode
  // ═══════════════════════════════════════════════════════════

  // Get autonomous mode status
  app.get('/api/autonomous/status', (_req: Request, res: Response) => {
    res.json(services.heartbeat.getAutonomousStatus());
  });

  // Enable autonomous mode
  app.post('/api/autonomous/enable', (_req: Request, res: Response) => {
    services.heartbeat.enableAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Disable autonomous mode
  app.post('/api/autonomous/disable', (_req: Request, res: Response) => {
    services.heartbeat.disableAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Pause autonomous mode
  app.post('/api/autonomous/pause', (_req: Request, res: Response) => {
    services.heartbeat.pauseAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Resume autonomous mode
  app.post('/api/autonomous/resume', (_req: Request, res: Response) => {
    services.heartbeat.resumeAutonomous();
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // Update autonomous config (interval, max steps, quiet hours)
  app.post('/api/autonomous/config', (req: Request, res: Response) => {
    const { intervalMinutes, maxStepsPerWake, quietHoursStart, quietHoursEnd } = req.body;
    services.heartbeat.updateAutonomousConfig({
      intervalMinutes, maxStepsPerWake, quietHoursStart, quietHoursEnd,
    });
    res.json({ success: true, status: services.heartbeat.getAutonomousStatus() });
  });

  // ── Author OS tools status ──
  app.get('/api/author-os/status', (_req: Request, res: Response) => {
    if (!services.authorOS) {
      return res.json({ tools: [] });
    }
    res.json({ tools: services.authorOS.getStatus() });
  });

  // ── Native Export: Markdown → Word/HTML (no external tools needed) ──
  app.post('/api/author-os/format', async (req: Request, res: Response) => {
    const { inputFile, title, author, formats, outputDir } = req.body;
    if (!inputFile) {
      return res.status(400).json({ error: 'inputFile required' });
    }

    const { join: j, resolve: r, basename: bn } = await import('path');
    const { existsSync: ex } = await import('fs');
    const { readFile: rf, writeFile: wf, mkdir: mkd } = await import('fs/promises');

    const workspaceDir = j(baseDir, 'workspace');
    const conductorDir = j(baseDir, 'conductor-output');

    // Search for the file in workspace → projects → conductor-output → baseDir
    const searchPaths = [
      r(workspaceDir, inputFile),
      r(workspaceDir, 'projects', inputFile),
      r(conductorDir, inputFile),
      r(baseDir, inputFile),
    ];
    // Also search recursively in workspace/projects/*/
    try {
      const { readdirSync } = await import('fs');
      const projectsDir = j(workspaceDir, 'projects');
      if (ex(projectsDir)) {
        for (const sub of readdirSync(projectsDir, { withFileTypes: true })) {
          if (sub.isDirectory()) {
            searchPaths.push(r(projectsDir, sub.name, inputFile));
          }
        }
      }
    } catch { /* ok */ }

    let resolvedInput = '';
    for (const candidate of searchPaths) {
      if (ex(candidate)) { resolvedInput = candidate; break; }
    }

    if (!resolvedInput) {
      return res.status(404).json({ error: 'Input file not found: ' + inputFile + '. Use /files to see available files.' });
    }

    // Security: must be within project
    const resolvedBase = r(baseDir);
    if (!resolvedInput.startsWith(resolvedBase)) {
      return res.status(403).json({ error: 'Input file must be within the AuthorClaw directory' });
    }

    const exportDir = r(workspaceDir, outputDir || 'exports');
    await mkd(exportDir, { recursive: true });

    const content = await rf(resolvedInput, 'utf-8');
    const docTitle = title || bn(resolvedInput, '.md');
    const docAuthor = author || 'AuthorClaw';
    const requestedFormats = formats || ['docx'];
    const results: string[] = [];

    try {
      // ── Word Export (native, using docx npm package) ──
      if (requestedFormats.includes('docx') || requestedFormats.includes('all')) {
        const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');
        const paragraphs: any[] = [];

        // Title page
        paragraphs.push(new Paragraph({ children: [new TextRun({ text: docTitle, bold: true, size: 48 })], spacing: { after: 400 } }));
        paragraphs.push(new Paragraph({ children: [new TextRun({ text: 'by ' + docAuthor, italics: true, size: 24 })], spacing: { after: 800 } }));
        paragraphs.push(new Paragraph({ children: [new TextRun({ text: '' })], spacing: { after: 400 } }));

        // Parse markdown content into paragraphs
        const lines = content.split('\n');
        for (const line of lines) {
          if (line.startsWith('# ')) {
            paragraphs.push(new Paragraph({ text: line.replace(/^# /, ''), heading: HeadingLevel.HEADING_1 }));
          } else if (line.startsWith('## ')) {
            paragraphs.push(new Paragraph({ text: line.replace(/^## /, ''), heading: HeadingLevel.HEADING_2 }));
          } else if (line.startsWith('### ')) {
            paragraphs.push(new Paragraph({ text: line.replace(/^### /, ''), heading: HeadingLevel.HEADING_3 }));
          } else if (line.trim() === '') {
            paragraphs.push(new Paragraph({ children: [] }));
          } else {
            // Handle basic bold/italic markdown
            const children: any[] = [];
            const parts = line.split(/(\*\*.*?\*\*|\*.*?\*)/);
            for (const part of parts) {
              if (part.startsWith('**') && part.endsWith('**')) {
                children.push(new TextRun({ text: part.slice(2, -2), bold: true }));
              } else if (part.startsWith('*') && part.endsWith('*')) {
                children.push(new TextRun({ text: part.slice(1, -1), italics: true }));
              } else {
                children.push(new TextRun({ text: part }));
              }
            }
            paragraphs.push(new Paragraph({ children }));
          }
        }

        const doc = new Document({
          creator: docAuthor,
          title: docTitle,
          sections: [{ children: paragraphs }],
        });

        const buffer = await Packer.toBuffer(doc);
        const outPath = j(exportDir, docTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-') + '.docx');
        await wf(outPath, buffer);
        results.push(outPath);
      }

      // ── HTML Export (native) ──
      if (requestedFormats.includes('html') || requestedFormats.includes('all')) {
        let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${docTitle}</title>`;
        html += `<style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.8;color:#333;}h1{text-align:center;border-bottom:2px solid #333;padding-bottom:10px;}h2{margin-top:2em;border-bottom:1px solid #ccc;}</style></head><body>`;
        html += `<h1>${docTitle}</h1><p style="text-align:center;"><em>by ${docAuthor}</em></p><hr>`;
        // Basic markdown → HTML
        const htmlContent = content
          .replace(/^### (.*$)/gm, '<h3>$1</h3>')
          .replace(/^## (.*$)/gm, '<h2>$1</h2>')
          .replace(/^# (.*$)/gm, '<h1>$1</h1>')
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>')
          .replace(/\n\n/g, '</p><p>')
          .replace(/\n/g, '<br>');
        html += `<p>${htmlContent}</p></body></html>`;
        const outPath = j(exportDir, docTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-') + '.html');
        await wf(outPath, html);
        results.push(outPath);
      }

      // ── Plain Text Export ──
      if (requestedFormats.includes('txt') || requestedFormats.includes('all')) {
        const plain = content.replace(/^#{1,3}\s/gm, '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
        const outPath = j(exportDir, docTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-') + '.txt');
        await wf(outPath, `${docTitle}\nby ${docAuthor}\n\n${plain}`);
        results.push(outPath);
      }

      res.json({ success: true, files: results, message: `Exported ${results.length} file(s) to ${exportDir}` });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Export failed: ' + String(error) });
    }
  });

  // ── Tool Ingestion: AI reads code, generates SKILL.md ──
  app.post('/api/tools/ingest', async (req: Request, res: Response) => {
    const { code, toolName, filePath, category } = req.body;

    if (!code && !filePath) {
      return res.status(400).json({ error: 'Provide "code" (source string) or "filePath" (relative to Author OS)' });
    }

    let sourceCode = code;

    if (filePath && !code) {
      const { readFile: rf } = await import('fs/promises');
      const { existsSync: ex } = await import('fs');
      const { resolve: r } = await import('path');

      const authorOSPath = services.authorOS?.getBasePath?.();
      if (!authorOSPath) {
        return res.status(400).json({ error: 'Author OS not mounted. Provide code directly.' });
      }

      const resolvedPath = r(authorOSPath, filePath);
      if (!resolvedPath.startsWith(r(authorOSPath))) {
        return res.status(403).json({ error: 'Path must be within Author OS directory' });
      }
      if (!ex(resolvedPath)) {
        return res.status(404).json({ error: `File not found: ${filePath}` });
      }

      sourceCode = await rf(resolvedPath, 'utf-8');
    }

    const targetCategory = category || 'author';
    const ingestPrompt = `You are analyzing source code to create an AuthorClaw SKILL.md file.

Tool name hint: ${toolName || '(infer from code)'}
Target category: ${targetCategory}

Analyze the following source code and generate a complete SKILL.md file with:
1. YAML frontmatter (name, description, triggers, permissions)
2. Detailed usage instructions
3. Input/output documentation
4. Example commands or workflows
5. How AuthorClaw should invoke or reference the tool

Return ONLY the complete SKILL.md content (starting with ---).

Source code:
\`\`\`
${sourceCode.substring(0, 15000)}
\`\`\``;

    try {
      const provider = services.aiRouter.selectProvider('general');
      const result = await services.aiRouter.complete({
        provider: provider.id,
        system: 'You are a technical documentation expert. Generate AuthorClaw SKILL.md files from source code analysis.',
        messages: [{ role: 'user', content: ingestPrompt }],
        maxTokens: 4096,
        temperature: 0.3,
      });

      res.json({
        skillMd: result.text,
        suggestedPath: `skills/${targetCategory}/${(toolName || 'unknown-tool').toLowerCase().replace(/[^a-z0-9]+/g, '-')}/SKILL.md`,
        provider: result.provider,
        tokens: result.tokensUsed,
      });
    } catch (error) {
      res.status(500).json({ error: 'AI analysis failed: ' + String(error) });
    }
  });

  // ── Tool Ingestion: Save generated SKILL.md ──
  app.post('/api/tools/ingest/save', async (req: Request, res: Response) => {
    const { skillMd, skillPath } = req.body;
    if (!skillMd || !skillPath) {
      return res.status(400).json({ error: 'skillMd and skillPath required' });
    }

    const { join: j, resolve: r } = await import('path');
    const { mkdir, writeFile } = await import('fs/promises');

    const fullPath = r(baseDir, skillPath);
    if (!fullPath.startsWith(r(j(baseDir, 'skills')))) {
      return res.status(403).json({ error: 'Can only save skills to the skills/ directory' });
    }

    try {
      await mkdir(j(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, skillMd, 'utf-8');

      await services.skills.loadAll();

      res.json({
        success: true,
        path: skillPath,
        totalSkills: services.skills.getLoadedCount(),
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to save skill: ' + String(error) });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Conductor Management (book-conductor.ts communication)
  // ═══════════════════════════════════════════════════════════

  // Conductor posts its status here (called by scripts/book-conductor.ts)
  app.post('/api/conductor/status', (req: Request, res: Response) => {
    const newState = req.body;
    const newPhase = newState.phase || '';
    const newChapters = newState.progress?.chaptersComplete || 0;

    // Detect meaningful milestones for Telegram notification
    let notification = '';

    if (newPhase !== previousConductorPhase && newPhase !== 'idle') {
      // Phase transition
      if (newPhase.startsWith('Complete')) {
        const wc = newState.progress?.wordCount || 0;
        const elapsed = newState.progress?.elapsedMs
          ? Math.round(newState.progress.elapsedMs / 60000)
          : '?';
        notification = `🎉 Conductor finished!\n${wc.toLocaleString()} words in ${elapsed} minutes`;
      } else if (newPhase.startsWith('Error') || newPhase === 'Stopped') {
        notification = `⚠️ Conductor ${newPhase.toLowerCase()}: ${newState.step || ''}`;
      } else {
        notification = `🎼 ${newPhase}\n${newState.step || ''}`;
      }
    } else if (newChapters > previousChaptersComplete && newChapters > 0) {
      // Chapter completion
      const total = newState.progress?.totalChapters || 25;
      const wc = newState.progress?.wordCount || 0;
      notification = `📖 Chapter ${newChapters}/${total} done (${wc.toLocaleString()} words total)`;
    }

    // Update tracking state
    previousConductorPhase = newPhase;
    previousChaptersComplete = newChapters;
    conductorState = newState;

    // Broadcast to Telegram if we have a notification
    if (notification && gateway.isTelegramConnected?.()) {
      gateway.broadcastTelegram?.(notification);
    }

    res.json({ ok: true, stopRequested: conductorStopRequested });
  });

  // Dashboard reads conductor status
  app.get('/api/conductor/status', (_req: Request, res: Response) => {
    res.json({ ...conductorState, stopRequested: conductorStopRequested });
  });

  // Dashboard sends stop signal — also kill the process if running
  app.post('/api/conductor/stop', (_req: Request, res: Response) => {
    conductorStopRequested = true;
    // Actually kill the conductor process (don't just set a flag)
    if (conductorProcess && conductorProcess.exitCode === null) {
      try {
        conductorProcess.kill('SIGTERM');
        setTimeout(() => {
          // Force kill if it didn't stop within 5 seconds
          if (conductorProcess && conductorProcess.exitCode === null) {
            conductorProcess.kill('SIGKILL');
          }
        }, 5000);
      } catch { /* process already dead */ }
    }
    res.json({ success: true, message: 'Conductor stopped' });
  });

  // Reset stop signal (when conductor starts)
  app.post('/api/conductor/start', (_req: Request, res: Response) => {
    conductorStopRequested = false;
    conductorState = { phase: 'starting', step: 'Initializing...', progress: {} };
    res.json({ success: true });
  });

  // Launch conductor as a child process
  app.post('/api/conductor/launch', async (req: Request, res: Response) => {
    if (conductorProcess && conductorProcess.exitCode === null) {
      return res.status(409).json({ error: 'Conductor is already running' });
    }

    // Pre-flight: verify at least one AI provider is active
    const providers = services.aiRouter.getActiveProviders();
    if (!providers || providers.length === 0) {
      return res.status(400).json({ error: 'No AI providers active. Add an API key in Settings first.' });
    }

    const { join: j } = await import('path');
    const { existsSync: ex } = await import('fs');
    const { mkdir: mkd, writeFile: wf, readFile: rf } = await import('fs/promises');
    const scriptPath = j(baseDir, 'scripts', 'book-conductor.ts');

    if (!ex(scriptPath)) {
      return res.status(404).json({ error: 'Conductor script not found at ' + scriptPath });
    }

    // Save config from launch request body (dashboard sends current form fields)
    const reqBody = req.body || {};
    const { totalChapters, targetChapterWordCount, premise, projectName, ...extraFields } = reqBody;
    const hasConfig = totalChapters || targetChapterWordCount || premise || projectName || Object.keys(extraFields).length > 0;
    if (hasConfig) {
      const configDir = j(baseDir, 'workspace', '.config');
      await mkd(configDir, { recursive: true });
      const configPath = j(configDir, 'project.json');
      let existing: any = {};
      try { existing = JSON.parse(await rf(configPath, 'utf-8')); } catch { /* new config */ }
      // Merge ALL fields from dashboard form into config
      const merged = { ...existing, ...extraFields };
      if (totalChapters) merged.totalChapters = Number(totalChapters);
      if (targetChapterWordCount) merged.targetChapterWordCount = Number(targetChapterWordCount);
      if (premise) merged.premise = premise;
      if (projectName) merged.projectName = projectName;
      await wf(configPath, JSON.stringify(merged, null, 2));
    }

    // Reset state
    conductorStopRequested = false;
    conductorState = { phase: 'starting', step: 'Launching conductor process...', progress: {} };

    try {
      conductorProcess = spawn('npx', ['tsx', scriptPath], {
        cwd: baseDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        env: { ...process.env },
      });

      conductorProcess.stdout?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.log('[conductor]', line);
      });

      conductorProcess.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.error('[conductor:err]', line);
      });

      conductorProcess.on('exit', (code) => {
        console.log(`[conductor] Process exited with code ${code}`);
        conductorProcess = null;
        if (conductorState.phase !== 'Complete!') {
          const exitPhase = code === 0 ? 'Complete!' : code === 2 ? 'Stopped (user)' : 'Stopped';
          const exitStep = code === 0 ? 'Finished successfully' : code === 2 ? 'Stopped by user' : `Exit code: ${code}`;
          conductorState = { phase: exitPhase, step: exitStep, progress: conductorState.progress || {} };
        }
      });

      conductorProcess.on('error', (err) => {
        console.error('[conductor] Process error:', err);
        conductorProcess = null;
        conductorState = { phase: 'Error', step: String(err), progress: {} };
      });

      await services.audit.log('conductor', 'launched', {});
      res.json({ success: true, message: 'Conductor launched', pid: conductorProcess.pid });
    } catch (error) {
      conductorProcess = null;
      res.status(500).json({ error: 'Failed to launch conductor: ' + String(error) });
    }
  });

  // Check if conductor process is running
  app.get('/api/conductor/running', (_req: Request, res: Response) => {
    const running = conductorProcess !== null && conductorProcess.exitCode === null;
    res.json({ running, pid: conductorProcess?.pid || null });
  });

  // Save project config for conductor
  app.post('/api/conductor/config', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { mkdir, writeFile } = await import('fs/promises');
    const configDir = j(baseDir, 'workspace', '.config');
    await mkdir(configDir, { recursive: true });
    await writeFile(j(configDir, 'project.json'), JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  });

  // Load project config for conductor
  app.get('/api/conductor/config', async (_req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const configPath = j(baseDir, 'workspace', '.config', 'project.json');
    if (ex(configPath)) {
      try {
        const data = JSON.parse(await rf(configPath, 'utf-8'));
        return res.json(data);
      } catch { /* fall through */ }
    }
    res.json({});
  });

  // ═══════════════════════════════════════════════════════════
  // Project Config Templates (saved configurations)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/conductor/config-templates', async (_req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readFile: rf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const templatesPath = j(baseDir, 'workspace', '.config', 'project-config-templates.json');
    let templates: any[] = [];
    if (ex(templatesPath)) {
      try { templates = JSON.parse(await rf(templatesPath, 'utf-8')); } catch { /* ok */ }
    }
    res.json({ templates });
  });

  app.post('/api/conductor/config-templates', async (req: Request, res: Response) => {
    const { name, config } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name required' });
    }
    const { join: j } = await import('path');
    const { readFile: rf, writeFile: wf, mkdir: mkd } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const { randomBytes } = await import('crypto');
    const configDir = j(baseDir, 'workspace', '.config');
    await mkd(configDir, { recursive: true });
    const templatesPath = j(configDir, 'project-config-templates.json');
    let templates: any[] = [];
    if (ex(templatesPath)) {
      try { templates = JSON.parse(await rf(templatesPath, 'utf-8')); } catch { /* ok */ }
    }
    templates.push({ id: randomBytes(6).toString('hex'), name, config: config || {}, createdAt: new Date().toISOString() });
    await wf(templatesPath, JSON.stringify(templates, null, 2));
    res.json({ success: true });
  });

  app.delete('/api/conductor/config-templates/:id', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { readFile: rf, writeFile: wf } = await import('fs/promises');
    const { existsSync: ex } = await import('fs');
    const templatesPath = j(baseDir, 'workspace', '.config', 'project-config-templates.json');
    if (!ex(templatesPath)) {
      return res.json({ success: false, error: 'No config templates' });
    }
    let templates: any[] = [];
    try { templates = JSON.parse(await rf(templatesPath, 'utf-8')); } catch { /* ok */ }
    templates = templates.filter((t: any) => t.id !== req.params.id);
    await wf(templatesPath, JSON.stringify(templates, null, 2));
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // TTS / Audio (Piper text-to-speech)
  // ═══════════════════════════════════════════════════════════

  // Generate audio from text
  app.post('/api/audio/generate', async (req: Request, res: Response) => {
    const { text, voice, format } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text required' });
    }
    if (text.length > 10000) {
      return res.status(400).json({ error: 'Text too long (max 10,000 chars)' });
    }

    if (!services.tts?.isAvailable()) {
      return res.status(503).json({
        error: 'TTS not available. Install Piper TTS: pip3 install piper-tts',
        install: 'pip3 install piper-tts',
      });
    }

    const result = await services.tts.generate(text, { voice, format: format || 'wav' });
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  });

  // Serve generated audio files
  app.get('/api/audio/file/:filename', async (req: Request, res: Response) => {
    const { join: j } = await import('path');
    const { existsSync: ex } = await import('fs');
    const fname = String(req.params.filename);
    const filePath = j(baseDir, 'workspace', 'audio', fname);

    // Security: prevent path traversal
    if (fname.includes('..') || fname.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    if (!ex(filePath)) {
      return res.status(404).json({ error: 'Audio file not found' });
    }

    const ext = fname.split('.').pop()?.toLowerCase();
    const contentType = ext === 'ogg' ? 'audio/ogg' : 'audio/wav';
    res.setHeader('Content-Type', contentType);
    const { createReadStream } = await import('fs');
    createReadStream(filePath).pipe(res);
  });

  // List available voices + known voices catalog
  app.get('/api/audio/voices', async (_req: Request, res: Response) => {
    const { TTSService } = await import('../services/tts.js');
    const installed = services.tts?.isAvailable() ? await services.tts.listVoices() : [];
    const activeVoice = services.tts?.getActiveVoice() || 'en_US-lessac-medium';
    res.json({
      available: services.tts?.isAvailable() || false,
      activeVoice,
      installed,
      knownVoices: TTSService.KNOWN_VOICES,
      install: services.tts?.isAvailable() ? undefined : 'pip3 install piper-tts',
    });
  });

  // Get/set the active voice
  app.get('/api/audio/voice', async (_req: Request, res: Response) => {
    res.json({ voice: services.tts?.getActiveVoice() || 'en_US-lessac-medium' });
  });

  app.post('/api/audio/voice', async (req: Request, res: Response) => {
    const { voice } = req.body;
    if (!voice || typeof voice !== 'string') {
      return res.status(400).json({ error: 'voice is required (e.g., "en_US-lessac-medium")' });
    }
    if (!services.tts) {
      return res.status(503).json({ error: 'TTS service not initialized' });
    }
    await services.tts.setVoice(voice);
    res.json({ success: true, voice, message: `Voice set to ${voice}. This persists across restarts.` });
  });
}
