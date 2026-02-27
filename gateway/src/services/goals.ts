/**
 * AuthorClaw Goal Engine
 * Autonomous goal-based task planning and execution
 *
 * Like OpenClaw's goal system: the user defines what they want to achieve,
 * and AuthorClaw autonomously selects the right tools, prompts, skills,
 * and workflows to accomplish it.
 *
 * Goal types:
 *   planning     - Story planning, outlining, brainstorming
 *   research     - Market research, fact-finding, comp analysis
 *   worldbuild   - Book bible, characters, settings, timelines
 *   writing      - Drafting chapters, scenes, prose
 *   revision     - Editing, feedback, consistency checks
 *   promotion    - Blurbs, query letters, social media, ads
 *   analysis     - Style analysis, manuscript autopsy, voice matching
 *   export       - Format and export manuscripts
 */

import { AuthorOSService } from './author-os.js';
import type { SkillCatalogEntry } from '../skills/loader.js';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

/**
 * Callback type for AI completion — injected by the gateway so GoalEngine
 * can call the AI without importing the router directly.
 */
export type AICompleteFunc = (request: {
  provider: string;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
}) => Promise<{ text: string; tokensUsed: number; estimatedCost: number; provider: string }>;

/**
 * Callback to select the best provider for a task type
 */
export type AISelectProviderFunc = (taskType: string) => { id: string };

export type GoalType =
  | 'planning'
  | 'research'
  | 'worldbuild'
  | 'writing'
  | 'revision'
  | 'promotion'
  | 'analysis'
  | 'export'
  | 'custom';

export interface Goal {
  id: string;
  type: GoalType;
  title: string;
  description: string;
  status: 'pending' | 'active' | 'paused' | 'completed' | 'failed';
  progress: number; // 0-100
  steps: GoalStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  context: Record<string, any>; // Arbitrary context for the goal
}

export interface GoalStep {
  id: string;
  label: string;
  skill?: string;         // Matched skill name
  toolSuggestion?: string; // Author OS tool to use
  taskType: string;        // AI router task type (for tier routing)
  prompt: string;          // The prompt to send to AI
  status: 'pending' | 'active' | 'completed' | 'skipped' | 'failed';
  result?: string;
  error?: string;
}

// ═══════════════════════════════════════════════════════════
// Goal Templates — Pre-built step sequences per goal type
// ═══════════════════════════════════════════════════════════

interface GoalTemplate {
  type: GoalType;
  label: string;
  description: string;
  steps: Array<{
    label: string;
    skill?: string;
    toolSuggestion?: string;
    taskType: string;
    promptTemplate: string; // Uses {{title}}, {{description}}, {{genre}}, etc.
  }>;
}

// Valid task types that the AI router understands (for planGoal prompt)
const TASK_TYPE_MAP: Record<string, string> = {
  general: 'Basic tasks, chat, simple questions',
  research: 'Web research, fact-finding',
  creative_writing: 'Prose writing, chapters, scenes',
  revision: 'Editing, rewriting, feedback',
  style_analysis: 'Voice/style matching',
  marketing: 'Blurbs, pitches, ads',
  outline: 'Story structure, beat sheets',
  book_bible: 'World building, characters',
  consistency: 'Cross-chapter analysis',
  final_edit: 'Final polish, proofreading',
};

const GOAL_TEMPLATES: GoalTemplate[] = [
  {
    type: 'planning',
    label: 'Story Planning',
    description: 'Develop a story from concept to detailed outline',
    steps: [
      {
        label: 'Develop premise',
        skill: 'premise',
        taskType: 'general',
        promptTemplate: 'Help me develop this story concept into a strong premise: {{description}}. Create a compelling logline, identify the core conflict, stakes, and theme.',
      },
      {
        label: 'Create character profiles',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Based on this premise: {{description}}\n\nCreate detailed character profiles for the protagonist and 3-4 key supporting characters. Include: name, age, background, motivation, internal conflict, external conflict, arc, and key relationships.',
      },
      {
        label: 'Build world and setting',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Based on this premise: {{description}}\n\nBuild out the world and setting. Include: locations (with sensory details), time period, social/political context, rules/constraints of the world, and atmosphere.',
      },
      {
        label: 'Create story outline',
        skill: 'outline',
        toolSuggestion: 'workflow-engine',
        taskType: 'outline',
        promptTemplate: 'Using this premise and the characters/world we developed: {{description}}\n\nCreate a detailed chapter-by-chapter outline. For each chapter include: chapter title, POV character, key events, emotional arc, and how it advances the main plot.',
      },
      {
        label: 'Review and refine',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: 'Review the complete story plan we created. Check for: plot holes, pacing issues, character consistency, thematic coherence, and narrative tension. Suggest specific improvements.',
      },
    ],
  },
  {
    type: 'research',
    label: 'Research & Market Analysis',
    description: 'Research genre, market, and subject matter for your book',
    steps: [
      {
        label: 'Genre analysis',
        skill: 'market-research',
        taskType: 'research',
        promptTemplate: 'Analyze the current market for this type of book: {{description}}. What are the top-selling comparable titles? What tropes and conventions does the genre expect? What are readers looking for?',
      },
      {
        label: 'Subject matter research',
        skill: 'research',
        taskType: 'research',
        promptTemplate: 'Research the key subject matter areas for: {{description}}. Provide factual background information, terminology, and details I need to write authentically about this topic.',
      },
      {
        label: 'Audience profiling',
        skill: 'market-research',
        taskType: 'research',
        promptTemplate: 'Profile the ideal reader for: {{description}}. Demographics, reading habits, what they love in books, what frustrates them, where they discover new books, and what would make them recommend this book.',
      },
      {
        label: 'Competitive positioning',
        skill: 'market-research',
        taskType: 'marketing',
        promptTemplate: 'Based on our research for: {{description}}\n\nHow should this book be positioned in the market? What makes it unique? What comp titles would you use in a query letter? What categories/keywords should it target?',
      },
    ],
  },
  {
    type: 'worldbuild',
    label: 'World Building',
    description: 'Create a comprehensive book bible with characters, settings, and lore',
    steps: [
      {
        label: 'Core world rules',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Create the foundational world rules for: {{description}}. Include: physical laws/magic system, technology level, social structures, power dynamics, history (key events), and any unique constraints.',
      },
      {
        label: 'Major locations',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Build out the major locations for: {{description}}. For each location: name, physical description, atmosphere, who lives/works there, significance to the plot, and sensory details (sounds, smells, textures).',
      },
      {
        label: 'Character ensemble',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Create the complete character ensemble for: {{description}}. For each character: full name, age, appearance, personality (strengths/flaws), backstory, motivation, relationships with other characters, speech patterns, and character arc.',
      },
      {
        label: 'Timeline and history',
        skill: 'book-bible',
        toolSuggestion: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Create a detailed timeline for: {{description}}. Include: backstory events before the novel begins, the chronological sequence of the plot, and any future implications. Note which characters are present at each key event.',
      },
      {
        label: 'Consistency rules',
        skill: 'book-bible',
        taskType: 'consistency',
        promptTemplate: 'Create a consistency guide/style sheet for: {{description}}. Include: naming conventions, spelling of made-up terms, character physical descriptions (hair, eyes, height), recurring phrases, technology rules, and any other details that must remain consistent.',
      },
    ],
  },
  {
    type: 'writing',
    label: 'Draft Writing',
    description: 'Write chapters or scenes for your book',
    steps: [
      {
        label: 'Review context',
        skill: 'manuscript-hub',
        taskType: 'general',
        promptTemplate: 'Before writing, review the current state of the project: {{description}}. What has been written so far? What comes next according to the outline? What voice and style should I maintain?',
      },
      {
        label: 'Write the draft',
        skill: 'write',
        taskType: 'creative_writing',
        promptTemplate: '{{description}}\n\nWrite this with vivid prose, strong voice, and attention to pacing. Target 3,000-4,000 words. Show, don\'t tell. Use dialogue to reveal character. End with a hook that pulls the reader forward.',
      },
      {
        label: 'Self-review',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: 'Review what we just wrote. Check for: voice consistency, pacing, show vs tell, dialogue quality, sensory details, and transitions. Suggest specific improvements but don\'t rewrite unless asked.',
      },
    ],
  },
  {
    type: 'revision',
    label: 'Revision & Editing',
    description: 'Edit and improve existing manuscript content',
    steps: [
      {
        label: 'Developmental edit',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: 'Perform a developmental edit on: {{description}}. Analyze: plot structure, character arcs, pacing, tension, thematic coherence, and narrative drive. Provide specific, actionable feedback.',
      },
      {
        label: 'Line edit',
        skill: 'revise',
        taskType: 'revision',
        promptTemplate: 'Perform a line edit on: {{description}}. Focus on: sentence rhythm, word choice, clarity, voice consistency, dialogue tags, and prose quality. Show specific before/after examples.',
      },
      {
        label: 'Consistency check',
        skill: 'revise',
        taskType: 'consistency',
        promptTemplate: 'Check for consistency issues in: {{description}}. Look for: character description changes, timeline errors, setting contradictions, technology/magic rule violations, and naming inconsistencies.',
      },
      {
        label: 'Beta reader simulation',
        skill: 'beta-reader',
        taskType: 'revision',
        promptTemplate: 'Read this as a beta reader: {{description}}. Give honest feedback on: what works well, what confused you, where you got bored, what felt unrealistic, and your overall emotional response. Rate engagement out of 10.',
      },
    ],
  },
  {
    type: 'promotion',
    label: 'Marketing & Promotion',
    description: 'Create marketing materials and promotion strategy',
    steps: [
      {
        label: 'Write book blurb',
        skill: 'blurb-writer',
        taskType: 'marketing',
        promptTemplate: 'Write a compelling book blurb for: {{description}}. Create 3 versions: (1) short tagline, (2) back-cover blurb (150 words), (3) Amazon description with HTML formatting. Each should hook the reader and convey genre/tone.',
      },
      {
        label: 'Draft query letter',
        skill: 'query-letter',
        taskType: 'marketing',
        promptTemplate: 'Write a professional query letter for: {{description}}. Include: hook, book summary, comparable titles, author bio placeholder, and word count. Follow industry standard format.',
      },
      {
        label: 'Social media content',
        skill: 'social-media',
        taskType: 'marketing',
        promptTemplate: 'Create a social media content plan for: {{description}}. Include: 5 Twitter/X posts, 3 Instagram captions, 2 TikTok video concepts, and 1 newsletter announcement. Match the book\'s tone and target audience.',
      },
      {
        label: 'Ad copy',
        skill: 'ad-copy',
        taskType: 'marketing',
        promptTemplate: 'Write advertising copy for: {{description}}. Create: 3 Amazon ad headlines, 2 Facebook ad variants, and 1 BookBub featured deal description. Focus on hooks that match the genre expectations.',
      },
    ],
  },
  {
    type: 'analysis',
    label: 'Book Launch Prep',
    description: 'Prepare everything you need to launch your book',
    steps: [
      {
        label: 'Write book blurb',
        skill: 'blurb-writer',
        taskType: 'marketing',
        promptTemplate: 'Write a compelling book blurb for: {{description}}. Create 3 versions: (1) one-line tagline, (2) back-cover blurb (150 words), (3) Amazon description. Each should hook the reader and convey genre/tone.',
      },
      {
        label: 'Create social media content',
        skill: 'social-media',
        taskType: 'marketing',
        promptTemplate: 'Create launch day social media content for: {{description}}. Include: 3 Twitter/X posts (with hashtags), 2 Instagram captions, and 1 TikTok/BookTok video concept. Match the book\'s tone.',
      },
      {
        label: 'Draft query letter',
        skill: 'query-letter',
        taskType: 'marketing',
        promptTemplate: 'Write a professional query letter for: {{description}}. Include: hook, book summary (250 words), comparable titles, target audience, and word count. Follow industry standard format.',
      },
    ],
  },
  {
    type: 'export',
    label: 'Character Deep Dive',
    description: 'Create detailed character profiles and relationship maps',
    steps: [
      {
        label: 'Build protagonist',
        skill: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Create a detailed protagonist profile for: {{description}}. Include: full backstory, motivation, fatal flaw, strengths, physical description, speech patterns, key relationships, and character arc from beginning to end.',
      },
      {
        label: 'Build antagonist and supporting cast',
        skill: 'book-bible',
        taskType: 'book_bible',
        promptTemplate: 'Based on the protagonist we created, build the antagonist and 3-4 supporting characters for: {{description}}. Each needs: motivation, backstory, role in the story, relationship to protagonist, and how they challenge or help the hero.',
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════
// Goal Engine
// ═══════════════════════════════════════════════════════════

export class GoalEngine {
  private goals: Map<string, Goal> = new Map();
  private authorOS: AuthorOSService | null;
  private nextId = 1;
  private aiComplete: AICompleteFunc | null = null;
  private aiSelectProvider: AISelectProviderFunc | null = null;

  constructor(authorOS?: AuthorOSService) {
    this.authorOS = authorOS || null;
  }

  /**
   * Wire up AI capabilities so GoalEngine can call the AI for dynamic planning.
   * Called after the router is initialized in index.ts.
   */
  setAI(complete: AICompleteFunc, selectProvider: AISelectProviderFunc): void {
    this.aiComplete = complete;
    this.aiSelectProvider = selectProvider;
  }

  // ── Template Discovery ──

  /**
   * Return all available goal templates for the dashboard
   */
  getTemplates(): Array<{ type: GoalType; label: string; description: string; stepCount: number }> {
    return GOAL_TEMPLATES.map(t => ({
      type: t.type,
      label: t.label,
      description: t.description,
      stepCount: t.steps.length,
    }));
  }

  // ── Dynamic Planning (The "Magic") ──

  /**
   * Ask the AI to decompose a task into steps dynamically.
   * This is the core "tell the agent what you want and it figures out the steps" feature.
   * Falls back to template-based planning if AI planning fails.
   */
  async planGoal(
    title: string,
    description: string,
    skillCatalog: SkillCatalogEntry[],
    authorOSTools: string[],
    context?: Record<string, any>
  ): Promise<Goal> {
    if (!this.aiComplete || !this.aiSelectProvider) {
      // No AI wired — fall back to template
      console.log('  ⚠ AI not wired for planning — falling back to template');
      const type = this.inferGoalType(description);
      return this.createGoal(type, title, description, context);
    }

    try {
      const provider = this.aiSelectProvider('general');

      // Build skill catalog for the planner prompt
      const skillList = skillCatalog.map(s =>
        `- **${s.name}** (${s.category}${s.premium ? ' ★' : ''}): ${s.description} [triggers: ${s.triggers.join(', ')}]`
      ).join('\n');

      const toolList = authorOSTools.length > 0
        ? `\n\nAuthor OS Tools Available:\n${authorOSTools.map(t => `- ${t}`).join('\n')}`
        : '';

      const validTaskTypes = Object.keys(TASK_TYPE_MAP).join(', ');

      const plannerPrompt = `You are a task planner for AuthorClaw, an autonomous AI writing agent.

The user wants to accomplish something. Your job is to break it down into a sequence of concrete, executable steps.

## Available Skills
${skillList}
${toolList}

## Valid Task Types
${validTaskTypes}

## Rules
1. Match step count to task complexity:
   - Simple tasks (write a blurb, intro, scene, short piece): 1-2 steps
   - Medium tasks (outline a story, research a topic, analyze style): 3-5 steps
   - Large tasks (write a full novel/book): 7-15 steps with ALL phases
2. ONLY plan full novel pipelines (premise → characters → world → outline → chapters → revision → assembly) when the user EXPLICITLY asks for a novel, book, or full manuscript
3. Each step should be a single, focused task
4. Reference specific skills by name when relevant
5. Use appropriate taskType for each step (affects which AI model is used)
6. Each step's prompt should be detailed enough to execute standalone
7. Later steps should reference earlier work naturally (e.g., "Using the characters we developed...")

## Output Format
Return ONLY valid JSON, no markdown fences, no explanation:
{"steps":[{"label":"step name","skill":"skill-name-or-null","taskType":"task_type","prompt":"detailed prompt for this step"}]}

## User's Request
Title: ${title}
Description: ${description}`;

      const result = await this.aiComplete({
        provider: provider.id,
        system: plannerPrompt,
        messages: [{ role: 'user', content: `Plan the steps to accomplish: ${description}` }],
        maxTokens: 4096,
        temperature: 0.3, // Low temperature for structured output
      });

      // Parse the AI's response
      const parsed = this.parsePlanResponse(result.text);

      if (parsed && parsed.steps && parsed.steps.length > 0) {
        // Build the goal from AI-planned steps
        const id = `goal-${this.nextId++}`;
        const now = new Date().toISOString();

        const steps: GoalStep[] = parsed.steps.map((s: any, i: number) => ({
          id: `${id}-step-${i + 1}`,
          label: s.label || `Step ${i + 1}`,
          skill: s.skill && s.skill !== 'null' ? s.skill : undefined,
          taskType: s.taskType || 'general',
          prompt: s.prompt || description,
          status: 'pending' as const,
        }));

        // Enhance with Author OS
        const enhancedSteps = this.authorOS ? this.enhanceWithAuthorOS(steps) : steps;

        const goal: Goal = {
          id,
          type: this.inferGoalType(description),
          title,
          description,
          status: 'pending',
          progress: 0,
          steps: enhancedSteps,
          createdAt: now,
          updatedAt: now,
          context: { ...context, planning: 'dynamic', planProvider: result.provider },
        };

        this.goals.set(id, goal);
        console.log(`  ✓ AI planned ${steps.length} steps for "${title}" (via ${result.provider})`);
        return goal;
      }

      // If parsing failed, fall back to template
      console.log('  ⚠ AI plan parsing failed — falling back to template');
      const type = this.inferGoalType(description);
      return this.createGoal(type, title, description, context);

    } catch (error) {
      console.error('  ✗ AI planning failed:', error);
      const type = this.inferGoalType(description);
      return this.createGoal(type, title, description, context);
    }
  }

  /**
   * Parse the AI's JSON plan response, handling common formatting issues
   */
  private parsePlanResponse(text: string): any {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '');
    cleaned = cleaned.trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      // Try to extract JSON from mixed text
      const jsonMatch = cleaned.match(/\{[\s\S]*"steps"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch { /* fall through */ }
      }
      return null;
    }
  }

  // ── Goal Lifecycle ──

  /**
   * Create a new goal from a template or custom definition.
   * Returns the goal with auto-planned steps.
   */
  createGoal(
    type: GoalType,
    title: string,
    description: string,
    context?: Record<string, any>
  ): Goal {
    const id = `goal-${this.nextId++}`;
    const now = new Date().toISOString();

    // Find matching template
    const template = GOAL_TEMPLATES.find(t => t.type === type);

    let steps: GoalStep[];

    if (template) {
      steps = template.steps.map((s, i) => ({
        id: `${id}-step-${i + 1}`,
        label: s.label,
        skill: s.skill,
        toolSuggestion: s.toolSuggestion,
        taskType: s.taskType,
        prompt: this.expandTemplate(s.promptTemplate, { title, description, ...context }),
        status: 'pending' as const,
      }));
    } else {
      // Custom goal — single step with the user's description
      steps = [{
        id: `${id}-step-1`,
        label: title,
        taskType: this.inferTaskType(description),
        prompt: description,
        status: 'pending',
      }];
    }

    // Enhance steps with Author OS tool suggestions if available
    if (this.authorOS) {
      steps = this.enhanceWithAuthorOS(steps);
    }

    const goal: Goal = {
      id,
      type,
      title,
      description,
      status: 'pending',
      progress: 0,
      steps,
      createdAt: now,
      updatedAt: now,
      context: context || {},
    };

    this.goals.set(id, goal);
    return goal;
  }

  /**
   * Get a specific goal by ID
   */
  getGoal(id: string): Goal | undefined {
    return this.goals.get(id);
  }

  /**
   * List all goals, optionally filtered by status
   */
  listGoals(status?: string): Goal[] {
    const goals = Array.from(this.goals.values());
    if (status) {
      return goals.filter(g => g.status === status);
    }
    return goals;
  }

  /**
   * Start executing a goal — marks it active and returns the first step
   */
  startGoal(id: string): GoalStep | null {
    const goal = this.goals.get(id);
    if (!goal) return null;

    goal.status = 'active';
    goal.updatedAt = new Date().toISOString();

    const firstPending = goal.steps.find(s => s.status === 'pending');
    if (firstPending) {
      firstPending.status = 'active';
      return firstPending;
    }

    return null;
  }

  /**
   * Complete the current step and advance to the next.
   * Returns the next step, or null if the goal is complete.
   */
  completeStep(goalId: string, stepId: string, result: string): GoalStep | null {
    const goal = this.goals.get(goalId);
    if (!goal) return null;

    const step = goal.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'completed';
      step.result = result;
    }

    // Calculate progress
    const completed = goal.steps.filter(s => s.status === 'completed').length;
    goal.progress = Math.round((completed / goal.steps.length) * 100);
    goal.updatedAt = new Date().toISOString();

    // Find next pending step
    const next = goal.steps.find(s => s.status === 'pending');
    if (next) {
      next.status = 'active';
      // Enrich the next prompt with results from completed steps
      next.prompt = this.enrichWithPriorResults(next.prompt, goal);
      return next;
    }

    // All steps done — mark goal complete
    goal.status = 'completed';
    goal.completedAt = new Date().toISOString();
    return null;
  }

  /**
   * Mark a step as failed
   */
  failStep(goalId: string, stepId: string, error: string): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    const step = goal.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'failed';
      step.error = error;
    }

    goal.updatedAt = new Date().toISOString();
  }

  /**
   * Skip a step
   */
  skipStep(goalId: string, stepId: string): GoalStep | null {
    const goal = this.goals.get(goalId);
    if (!goal) return null;

    const step = goal.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'skipped';
    }

    // Update progress
    const done = goal.steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
    goal.progress = Math.round((done / goal.steps.length) * 100);
    goal.updatedAt = new Date().toISOString();

    // Advance
    const next = goal.steps.find(s => s.status === 'pending');
    if (next) {
      next.status = 'active';
      return next;
    }

    goal.status = 'completed';
    goal.completedAt = new Date().toISOString();
    return null;
  }

  /**
   * Pause a goal
   */
  pauseGoal(id: string): void {
    const goal = this.goals.get(id);
    if (!goal) return;
    goal.status = 'paused';
    goal.updatedAt = new Date().toISOString();

    // Pause any active steps
    goal.steps.forEach(s => {
      if (s.status === 'active') s.status = 'pending';
    });
  }

  /**
   * Delete a goal
   */
  deleteGoal(id: string): boolean {
    return this.goals.delete(id);
  }

  /**
   * Build the system prompt addition for a goal step.
   * This tells the AI what context it's operating in.
   */
  buildGoalContext(goal: Goal, step: GoalStep): string {
    let context = `\n# Current Goal\n\n`;
    context += `**Goal**: ${goal.title}\n`;
    context += `**Type**: ${goal.type}\n`;
    context += `**Progress**: ${goal.progress}% (step ${goal.steps.indexOf(step) + 1} of ${goal.steps.length})\n`;
    context += `**Current Step**: ${step.label}\n\n`;

    // Add results from prior steps as context
    const completedSteps = goal.steps.filter(s => s.status === 'completed' && s.result);
    if (completedSteps.length > 0) {
      context += `## Previous Steps Completed\n\n`;
      for (const cs of completedSteps) {
        context += `### ${cs.label}\n`;
        // Truncate very long results to last 2000 chars
        const result = cs.result!;
        if (result.length > 2000) {
          context += `[...truncated...]\n${result.slice(-2000)}\n\n`;
        } else {
          context += `${result}\n\n`;
        }
      }
    }

    // Add Author OS tool suggestion with actionable instructions
    if (step.toolSuggestion) {
      const toolInstructions: Record<string, string> = {
        'workflow-engine': 'Load the relevant JSON workflow template and follow its step sequence.',
        'book-bible': 'Use the Book Bible data for character/world consistency checks.',
        'manuscript-autopsy': 'Run manuscript analysis for pacing and structure feedback.',
        'format-factory': 'Use Format Factory Pro: python format_factory_pro.py <input> -t "Title" --all',
        'creator-asset-suite': 'Generate marketing assets using the Creator Asset Suite tools.',
        'ai-author-library': 'Reference writing prompts and voice markers from the library.',
      };
      context += `\n**Suggested Tool**: Author OS ${step.toolSuggestion}\n`;
      const instruction = toolInstructions[step.toolSuggestion];
      if (instruction) {
        context += `**How to use**: ${instruction}\n`;
      }
    }

    return context;
  }

  // ── Smart Goal from Natural Language ──

  /**
   * Infer the best goal type from a natural language description.
   * Used when the user just says what they want without specifying a type.
   */
  inferGoalType(description: string): GoalType {
    const lower = description.toLowerCase();

    // Planning signals
    if (lower.match(/plan|outline|structure|plot|brainstorm|concept|idea|story map|beat sheet|premise|logline|what.?if/)) {
      return 'planning';
    }

    // Research signals
    if (lower.match(/research|market|comp|comparable|audience|genre analysis|investigate/)) {
      return 'research';
    }

    // World building signals
    if (lower.match(/world.?build|book.?bible|character|setting|lore|magic system|timeline|backstory/)) {
      return 'worldbuild';
    }

    // Writing signals
    if (lower.match(/write|draft|chapter|scene|prose|manuscript/)) {
      return 'writing';
    }

    // Revision signals
    if (lower.match(/edit|revise|rewrite|feedback|critique|proofread|consistency|beta read/)) {
      return 'revision';
    }

    // Promotion signals
    if (lower.match(/promote|market|blurb|query|social media|ad copy|launch|advertise/)) {
      return 'promotion';
    }

    // Analysis signals
    if (lower.match(/style|voice|analyz|tone|match my|clone/)) {
      return 'analysis';
    }

    // Export signals
    if (lower.match(/export|format|compile|epub|pdf|docx|publish/)) {
      return 'export';
    }

    return 'custom';
  }

  // ── Private Helpers ──

  private expandTemplate(template: string, vars: Record<string, any>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value === 'string') {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
      }
    }
    // Clean up any remaining unexpanded vars
    result = result.replace(/\{\{[^}]+\}\}/g, '');
    return result;
  }

  private inferTaskType(description: string): string {
    const type = this.inferGoalType(description);
    const taskMap: Record<GoalType, string> = {
      planning: 'outline',
      research: 'research',
      worldbuild: 'book_bible',
      writing: 'creative_writing',
      revision: 'revision',
      promotion: 'marketing',
      analysis: 'style_analysis',
      export: 'general',
      custom: 'general',
    };
    return taskMap[type] || 'general';
  }

  private enhanceWithAuthorOS(steps: GoalStep[]): GoalStep[] {
    if (!this.authorOS) return steps;

    const availableTools = this.authorOS.getAvailableTools();
    return steps.map(step => {
      // If the step suggests a tool, check if it's available
      if (step.toolSuggestion && !availableTools.includes(step.toolSuggestion)) {
        // Tool not available — clear suggestion but keep the step
        step.toolSuggestion = undefined;
      }
      return step;
    });
  }

  private enrichWithPriorResults(prompt: string, goal: Goal): string {
    // If the prompt already references previous work, skip
    if (prompt.includes('we developed') || prompt.includes('we created')) {
      return prompt;
    }

    // Add a brief context note from the last completed step
    const lastCompleted = [...goal.steps].reverse().find(s => s.status === 'completed' && s.result);
    if (lastCompleted && lastCompleted.result) {
      const brief = lastCompleted.result.length > 500
        ? lastCompleted.result.slice(0, 500) + '...'
        : lastCompleted.result;
      return `[Context from "${lastCompleted.label}": ${brief}]\n\n${prompt}`;
    }

    return prompt;
  }
}
