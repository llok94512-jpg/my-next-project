import { Router } from 'express';
import { all, get } from '../db.js';
import { asyncHandler, HttpError, str, toInt } from '../lib/http.js';
import { requireAuth } from '../auth.js';

const router = Router();

const API_KEY = () => process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
const BASE_URL = () => (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = () => process.env.AI_MODEL || 'gpt-4o-mini';

router.get('/ai/status', requireAuth, (_req, res) => {
  res.json({
    configured: Boolean(API_KEY()),
    model: API_KEY() ? MODEL() : null,
    provider: API_KEY() ? 'openai-compatible' : null,
  });
});

function systemPrompt(user, { mode, subject }) {
  const band = user.class_level <= 2 ? 'a very young child (Class 1-2)' : user.class_level <= 5 ? 'a primary school pupil (Class 3-5)' : 'a middle school student (Class 6-8)';
  const lines = [
    'You are STUDYFLIX AI, a patient school tutor inside a learning platform.',
    `The student is in Class ${user.class_level} and should be treated as ${band}.`,
    'Explain in short, clear sentences with simple examples. Use headings and bullet points.',
    'Never produce content that is unsafe, violent, sexual or age-inappropriate.',
    'Never ask for or reveal personal data about any student, and never discuss other students.',
    'If a question is outside school learning, gently redirect to study topics.',
    'When you are unsure, say so plainly and encourage the student to ask their teacher.',
  ];
  if (subject) lines.push(`The current subject is ${subject}.`);
  if (mode === 'islamic') {
    lines.push(
      'This is Islamic Studies mode. Use only well-established, widely accepted information.',
      'Quote Quran and hadith only when you are certain of the wording; otherwise describe the meaning and clearly say the exact reference should be verified with a teacher.',
      'Never invent verses, hadith, or religious rulings, and never issue fatwas. Refer rulings to a qualified teacher or scholar.',
    );
  }
  if (mode === 'maths') lines.push('Show step-by-step working, one step per line, then the final answer.');
  return lines.join(' ');
}

router.post(
  '/ai/chat',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'student' && req.user.role !== 'teacher' && req.user.role !== 'super_admin') {
      throw new HttpError(403, 'Not available.');
    }
    if (!API_KEY()) {
      return res.status(503).json({
        configured: false,
        error:
          'STUDYFLIX AI is not connected yet. An administrator needs to add an AI provider key (AI_API_KEY) in the platform settings.',
      });
    }
    const message = str(req.body.message, 2000);
    if (!message) throw new HttpError(400, 'Type a question for STUDYFLIX AI.');
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
    const mode = ['islamic', 'maths', 'general'].includes(req.body.mode) ? req.body.mode : 'general';
    const subject = str(req.body.subject, 80);

    const payload = {
      model: MODEL(),
      temperature: 0.3,
      max_tokens: 700,
      messages: [
        { role: 'system', content: systemPrompt(req.user, { mode, subject }) },
        ...history
          .filter((entry) => entry && typeof entry.content === 'string')
          .map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: entry.content.slice(0, 2000) })),
        { role: 'user', content: message },
      ],
    };

    let response;
    try {
      response = await fetch(`${BASE_URL()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY()}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000),
      });
    } catch (error) {
      return res.status(502).json({ configured: true, error: `The AI provider could not be reached: ${error.message}` });
    }
    if (!response.ok) {
      const detail = await response.text();
      const hint =
        response.status === 401 || response.status === 403
          ? 'The AI provider rejected the key. An administrator needs to check AI_API_KEY.'
          : response.status === 429
            ? 'The AI provider is rate limited or out of credit. Please try again later.'
            : 'The AI provider returned an error.';
      return res.status(502).json({ configured: true, error: hint, detail: detail.slice(0, 300) });
    }
    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content?.trim();
    if (!answer) return res.status(502).json({ configured: true, error: 'The AI provider returned an empty answer.' });
    res.json({ configured: true, answer, model: MODEL(), mode });
  }),
);

/** Suggested revision questions, generated from the student's own class subjects. */
router.get(
  '/ai/prompts',
  requireAuth,
  asyncHandler(async (req, res) => {
    const subjects = all(
      'SELECT s.name FROM subjects s JOIN subject_classes sc ON sc.subject_id = s.id WHERE sc.class_level = ? ORDER BY s.name',
      [toInt(req.user.class_level, 1)],
    );
    res.json({
      suggestions: [
        'Explain today’s lesson in simple words.',
        'Give me 5 practice questions on fractions.',
        'Summarise the water cycle for my class.',
        'Help me understand this grammar rule: past continuous.',
        'Make a short revision plan for my science test.',
        ...subjects.slice(0, 3).map((subject) => `Explain an important topic in ${subject.name}.`),
      ],
      subjects: subjects.map((subject) => subject.name),
      note: get('SELECT 1 AS ok') ? undefined : undefined,
    });
  }),
);

export default router;
