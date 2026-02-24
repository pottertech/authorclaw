/**
 * AuthorClaw Heartbeat Service
 * Writing session tracker, goal monitor, deadline alerts, milestone celebrations
 *
 * v2.1: Autonomous mode — wakes up on schedule, checks for active goals,
 * and executes the next step automatically. The writing agent that works
 * while you sleep (but respects your quiet hours).
 */

import { MemoryService } from './memory.js';

interface WritingSession {
  startTime: Date;
  lastActivity: Date;
  wordCountStart: number;
  wordCountCurrent: number;
  channel: string;
}

interface HeartbeatConfig {
  intervalMinutes: number;
  dailyWordGoal: number;
  enableReminders: boolean;
  quietHoursStart: number; // 24h format
  quietHoursEnd: number;
  // Autonomous mode
  autonomousEnabled: boolean;
  autonomousIntervalMinutes: number; // How often to check for work (default: 30)
  maxAutonomousStepsPerWake: number; // Safety limit per wake cycle (default: 5)
}

/**
 * Callback type for autonomous goal execution.
 * Injected by the gateway so heartbeat can trigger goal steps
 * without importing the goal engine or AI router directly.
 */
export type AutonomousRunFunc = (goalId: string) => Promise<
  { completed: string; response: string; wordCount: number; nextStep?: string } | { error: string }
>;

export type AutonomousGoalListFunc = () => Array<{
  id: string;
  title: string;
  status: string;
  progress: string;
  stepsRemaining: number;
}>;

export type StatusBroadcastFunc = (message: string) => void;

export class HeartbeatService {
  private config: HeartbeatConfig;
  private memory: MemoryService;
  private timer: ReturnType<typeof setInterval> | null = null;
  private autonomousTimer: ReturnType<typeof setInterval> | null = null;
  private currentSession: WritingSession | null = null;
  private todayWords = 0;
  private streak = 0;
  private lastWritingDate: string | null = null;

  // Autonomous mode
  private autonomousRunStep: AutonomousRunFunc | null = null;
  private autonomousListGoals: AutonomousGoalListFunc | null = null;
  private statusBroadcast: StatusBroadcastFunc | null = null;
  private autonomousPaused = false;
  private isRunning = false; // Prevent overlapping autonomous runs
  private autonomousLog: Array<{ timestamp: string; message: string }> = [];
  private totalAutonomousSteps = 0;
  private totalAutonomousWords = 0;

  constructor(config: Partial<HeartbeatConfig>, memory: MemoryService) {
    this.config = {
      intervalMinutes: config.intervalMinutes ?? 15,
      dailyWordGoal: config.dailyWordGoal ?? 1000,
      enableReminders: config.enableReminders ?? true,
      quietHoursStart: config.quietHoursStart ?? 22,
      quietHoursEnd: config.quietHoursEnd ?? 7,
      autonomousEnabled: config.autonomousEnabled ?? false,
      autonomousIntervalMinutes: config.autonomousIntervalMinutes ?? 30,
      maxAutonomousStepsPerWake: config.maxAutonomousStepsPerWake ?? 5,
    };
    this.memory = memory;
  }

  /**
   * Wire up autonomous capabilities. Called after goal engine and AI are ready.
   */
  setAutonomous(
    runStep: AutonomousRunFunc,
    listGoals: AutonomousGoalListFunc,
    broadcast: StatusBroadcastFunc
  ): void {
    this.autonomousRunStep = runStep;
    this.autonomousListGoals = listGoals;
    this.statusBroadcast = broadcast;
  }

  start(): void {
    // Standard heartbeat timer (session tracking, streaks)
    this.timer = setInterval(
      () => this.tick(),
      this.config.intervalMinutes * 60 * 1000
    );

    // Autonomous timer (goal execution) — separate interval
    if (this.config.autonomousEnabled && this.autonomousRunStep) {
      this.startAutonomous();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopAutonomous();
  }

  // ── Autonomous Mode Control ──

  /**
   * Enable autonomous mode at runtime (e.g., from dashboard or Telegram)
   */
  enableAutonomous(): void {
    this.config.autonomousEnabled = true;
    this.autonomousPaused = false;
    if (!this.autonomousTimer && this.autonomousRunStep) {
      this.startAutonomous();
    }
    this.logAutonomous('🤖 Autonomous mode ENABLED');
    this.broadcast('🤖 Autonomous mode enabled — I\'ll check for goals every ' +
      this.config.autonomousIntervalMinutes + ' minutes');
  }

  /**
   * Disable autonomous mode
   */
  disableAutonomous(): void {
    this.config.autonomousEnabled = false;
    this.stopAutonomous();
    this.logAutonomous('⏹ Autonomous mode DISABLED');
    this.broadcast('⏹ Autonomous mode disabled — I\'ll wait for your instructions');
  }

  /**
   * Pause autonomous mode temporarily (resumes on next enableAutonomous call)
   */
  pauseAutonomous(): void {
    this.autonomousPaused = true;
    this.logAutonomous('⏸ Autonomous mode PAUSED');
    this.broadcast('⏸ Autonomous mode paused');
  }

  /**
   * Resume autonomous mode after pause
   */
  resumeAutonomous(): void {
    this.autonomousPaused = false;
    this.logAutonomous('▶️ Autonomous mode RESUMED');
    this.broadcast('▶️ Autonomous mode resumed');
  }

  /**
   * Check if autonomous mode is active and not paused
   */
  isAutonomousActive(): boolean {
    return this.config.autonomousEnabled && !this.autonomousPaused;
  }

  /**
   * Get autonomous mode status for dashboard/API
   */
  getAutonomousStatus(): {
    enabled: boolean;
    paused: boolean;
    running: boolean;
    intervalMinutes: number;
    maxStepsPerWake: number;
    quietHoursStart: number;
    quietHoursEnd: number;
    totalStepsExecuted: number;
    totalWordsGenerated: number;
    recentLog: Array<{ timestamp: string; message: string }>;
  } {
    return {
      enabled: this.config.autonomousEnabled,
      paused: this.autonomousPaused,
      running: this.isRunning,
      intervalMinutes: this.config.autonomousIntervalMinutes,
      maxStepsPerWake: this.config.maxAutonomousStepsPerWake,
      quietHoursStart: this.config.quietHoursStart,
      quietHoursEnd: this.config.quietHoursEnd,
      totalStepsExecuted: this.totalAutonomousSteps,
      totalWordsGenerated: this.totalAutonomousWords,
      recentLog: this.autonomousLog.slice(-20), // Last 20 entries
    };
  }

  /**
   * Update autonomous configuration at runtime
   */
  updateAutonomousConfig(updates: {
    intervalMinutes?: number;
    maxStepsPerWake?: number;
    quietHoursStart?: number;
    quietHoursEnd?: number;
  }): void {
    if (updates.intervalMinutes !== undefined) {
      this.config.autonomousIntervalMinutes = updates.intervalMinutes;
    }
    if (updates.maxStepsPerWake !== undefined) {
      this.config.maxAutonomousStepsPerWake = updates.maxStepsPerWake;
    }
    if (updates.quietHoursStart !== undefined) {
      this.config.quietHoursStart = updates.quietHoursStart;
    }
    if (updates.quietHoursEnd !== undefined) {
      this.config.quietHoursEnd = updates.quietHoursEnd;
    }

    // Restart autonomous timer with new interval
    if (this.config.autonomousEnabled && this.autonomousRunStep) {
      this.stopAutonomous();
      this.startAutonomous();
    }

    this.logAutonomous(`⚙️ Config updated: interval=${this.config.autonomousIntervalMinutes}min, ` +
      `maxSteps=${this.config.maxAutonomousStepsPerWake}, ` +
      `quiet=${this.config.quietHoursStart}:00-${this.config.quietHoursEnd}:00`);
  }

  // ── Standard Heartbeat ──

  private async tick(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();

    // Respect quiet hours
    if (this.isQuietHours(hour)) {
      return;
    }

    // Check for day rollover
    const today = now.toISOString().split('T')[0];
    if (this.lastWritingDate && this.lastWritingDate !== today) {
      // Check if yesterday had words (streak tracking)
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      if (this.lastWritingDate === yesterdayStr && this.todayWords > 0) {
        this.streak++;
      } else if (this.lastWritingDate !== yesterdayStr) {
        this.streak = 0;
      }

      this.todayWords = 0;
    }
  }

  // ── Autonomous Wake Cycle ──

  private startAutonomous(): void {
    if (this.autonomousTimer) return; // Already running

    // Run first check after a short delay (let the system fully boot)
    setTimeout(() => {
      if (this.config.autonomousEnabled) {
        this.autonomousWake();
      }
    }, 60_000); // 1 minute after start

    this.autonomousTimer = setInterval(
      () => this.autonomousWake(),
      this.config.autonomousIntervalMinutes * 60 * 1000
    );
  }

  private stopAutonomous(): void {
    if (this.autonomousTimer) {
      clearInterval(this.autonomousTimer);
      this.autonomousTimer = null;
    }
  }

  /**
   * The autonomous wake cycle. This is where the magic happens.
   * Runs on schedule, finds active goals, and executes steps.
   */
  private async autonomousWake(): Promise<void> {
    // Guard: don't run if disabled, paused, in quiet hours, or already running
    if (!this.config.autonomousEnabled) return;
    if (this.autonomousPaused) return;
    if (this.isQuietHours(new Date().getHours())) return;
    if (this.isRunning) return;
    if (!this.autonomousRunStep || !this.autonomousListGoals) return;

    this.isRunning = true;
    const wakeTime = new Date().toISOString();
    this.logAutonomous(`⏰ Waking up — checking for work...`);

    try {
      // Get all goals
      const goals = this.autonomousListGoals();

      // Find goals that need work (active first, then pending)
      const activeGoals = goals.filter(g => g.status === 'active' && g.stepsRemaining > 0);
      const pendingGoals = goals.filter(g => g.status === 'pending' && g.stepsRemaining > 0);
      const workableGoals = [...activeGoals, ...pendingGoals];

      if (workableGoals.length === 0) {
        this.logAutonomous(`😴 No goals need work — going back to sleep`);
        this.isRunning = false;
        return;
      }

      // Pick the first workable goal (active goals get priority)
      const targetGoal = workableGoals[0];
      this.logAutonomous(`📋 Found goal: "${targetGoal.title}" (${targetGoal.progress}, ${targetGoal.stepsRemaining} steps remaining)`);
      this.broadcast(`⏰ Autonomous wake — working on: "${targetGoal.title}"`);

      // Execute up to maxStepsPerWake steps
      let stepsThisWake = 0;
      let wordsThisWake = 0;

      for (let i = 0; i < this.config.maxAutonomousStepsPerWake; i++) {
        // Re-check guards each iteration
        if (this.autonomousPaused) {
          this.logAutonomous(`⏸ Paused mid-cycle after ${stepsThisWake} steps`);
          this.broadcast(`⏸ Paused mid-cycle after ${stepsThisWake} steps`);
          break;
        }

        if (this.isQuietHours(new Date().getHours())) {
          this.logAutonomous(`🌙 Entering quiet hours — stopping after ${stepsThisWake} steps`);
          this.broadcast(`🌙 Entering quiet hours — stopping after ${stepsThisWake} steps`);
          break;
        }

        const result = await this.autonomousRunStep(targetGoal.id);

        if ('error' in result) {
          this.logAutonomous(`❌ Step failed: ${result.error}`);
          this.broadcast(`❌ Autonomous step failed: ${result.error}`);
          break;
        }

        stepsThisWake++;
        wordsThisWake += result.wordCount || 0;
        this.totalAutonomousSteps++;
        this.totalAutonomousWords += result.wordCount || 0;

        this.logAutonomous(`✅ Completed: "${result.completed}" (~${result.wordCount.toLocaleString()} words)`);

        if (!result.nextStep) {
          // Goal is complete!
          this.logAutonomous(`🎉 Goal "${targetGoal.title}" COMPLETE!`);
          this.broadcast(
            `🎉 Goal "${targetGoal.title}" complete!\n` +
            `📊 This wake: ${stepsThisWake} steps, ~${wordsThisWake.toLocaleString()} words\n` +
            `📁 Files saved to workspace/projects/`
          );
          break;
        }

        // Brief pause between steps (be respectful of API rate limits)
        await this.sleep(3000);
      }

      if (stepsThisWake > 0) {
        const summary = `📊 Wake cycle done: ${stepsThisWake} steps, ~${wordsThisWake.toLocaleString()} words`;
        this.logAutonomous(summary);
        if (stepsThisWake < this.config.maxAutonomousStepsPerWake) {
          // Goal completed or paused — already broadcast above
        } else {
          this.broadcast(
            summary + `\n⏰ Next wake in ${this.config.autonomousIntervalMinutes} minutes`
          );
        }
      }

    } catch (error) {
      this.logAutonomous(`💥 Error during autonomous wake: ${error}`);
      console.error('Autonomous wake error:', error);
    } finally {
      this.isRunning = false;
    }
  }

  // ── Helpers ──

  private isQuietHours(hour: number): boolean {
    if (this.config.quietHoursStart > this.config.quietHoursEnd) {
      // Quiet hours span midnight (e.g., 22-7)
      return hour >= this.config.quietHoursStart || hour < this.config.quietHoursEnd;
    }
    // Quiet hours within same day (e.g., 1-6)
    return hour >= this.config.quietHoursStart && hour < this.config.quietHoursEnd;
  }

  private logAutonomous(message: string): void {
    const entry = { timestamp: new Date().toISOString(), message };
    this.autonomousLog.push(entry);
    // Keep last 100 entries
    if (this.autonomousLog.length > 100) {
      this.autonomousLog = this.autonomousLog.slice(-100);
    }
    console.log(`  💓 ${message}`);
  }

  private broadcast(message: string): void {
    if (this.statusBroadcast) {
      this.statusBroadcast(message);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Activity Tracking (unchanged) ──

  recordActivity(type: string, data: Record<string, any>): void {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    this.lastWritingDate = today;

    if (type === 'word_count_update') {
      this.todayWords = data.todayTotal || this.todayWords;
    }
  }

  startSession(channel: string, startingWordCount: number): void {
    this.currentSession = {
      startTime: new Date(),
      lastActivity: new Date(),
      wordCountStart: startingWordCount,
      wordCountCurrent: startingWordCount,
      channel,
    };
  }

  updateSession(wordCount: number): void {
    if (this.currentSession) {
      this.currentSession.wordCountCurrent = wordCount;
      this.currentSession.lastActivity = new Date();
    }
  }

  endSession(): { duration: number; wordsWritten: number } | null {
    if (!this.currentSession) return null;

    const duration = Date.now() - this.currentSession.startTime.getTime();
    const wordsWritten = this.currentSession.wordCountCurrent - this.currentSession.wordCountStart;
    this.currentSession = null;

    return { duration, wordsWritten };
  }

  getContext(): string {
    const parts: string[] = [];

    // Daily goal progress
    const goalPercent = Math.min(100, Math.round((this.todayWords / this.config.dailyWordGoal) * 100));
    parts.push(`Daily word goal: ${this.todayWords}/${this.config.dailyWordGoal} (${goalPercent}%)`);

    // Streak
    if (this.streak > 0) {
      parts.push(`Writing streak: ${this.streak} days 🔥`);
    }

    // Active session
    if (this.currentSession) {
      const minutes = Math.round((Date.now() - this.currentSession.startTime.getTime()) / 60000);
      const sessionWords = this.currentSession.wordCountCurrent - this.currentSession.wordCountStart;
      parts.push(`Active session: ${minutes}min, ${sessionWords} words this session`);
    }

    // Autonomous mode status
    if (this.config.autonomousEnabled) {
      const status = this.autonomousPaused ? '⏸ paused' : this.isRunning ? '🔄 working' : '✅ active';
      parts.push(`Autonomous mode: ${status} (every ${this.config.autonomousIntervalMinutes}min, ${this.totalAutonomousSteps} steps total)`);
    }

    return parts.join('\n');
  }
}
