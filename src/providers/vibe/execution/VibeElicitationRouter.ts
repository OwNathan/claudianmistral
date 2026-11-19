import type {
  ACPCreateElicitationRequest,
  ACPCreateElicitationResponse,
  ACPElicitationEnumOption,
  ACPElicitationProperty,
} from '@/providers/acp';

import {
  PendingInteractionLedger,
  type ProviderInteractionDismissReason,
  type ProviderInteractionPort,
} from '../../../core/execution';
import type { AskUserAnswers } from '../../../core/types';

const CANCELLED: ACPCreateElicitationResponse = { action: 'cancel' };
const DECLINED: ACPCreateElicitationResponse = { action: 'decline' };

interface VibeElicitationQuestion {
  readonly fieldId: string;
  readonly header: string | null;
  readonly multiSelect: boolean;
  readonly options: readonly ACPElicitationEnumOption[];
  readonly question: string;
}

/**
 * Routes Vibe's `ask_user_question` form elicitations through Claudian's
 * question UI. Vibe keys each question `q0..qN`, carrying the question text
 * as the property description and the header as its title; option consts are
 * the option labels, and Vibe accepts free text that matches no option.
 */
export class VibeElicitationRouter {
  private sequence = 0;
  private readonly pending: PendingInteractionLedger;

  constructor(
    private readonly interactionPort: ProviderInteractionPort,
    private readonly sessionInstanceId: string,
    private readonly getTurnId: () => string | null,
  ) {
    this.pending = new PendingInteractionLedger(interactionPort);
  }

  async handle(
    request: ACPCreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<ACPCreateElicitationResponse> {
    const turnId = this.getTurnId();
    const questions = parseQuestions(request);
    if (!turnId || !questions || signal?.aborted) return CANCELLED;

    const pending = this.pending.begin(
      `${this.sessionInstanceId}:question:${++this.sequence}`,
      signal,
    );
    if (!pending) return CANCELLED;
    let dismissReason: ProviderInteractionDismissReason = 'cancelled';
    try {
      const response = await this.interactionPort.askUserQuestion({
        input: {
          questions: questions.map((question, index) => ({
            header: question.header ?? `Q${index + 1}`,
            id: question.fieldId,
            // Vibe never enforces enum matching, so "Other" free text is always valid.
            isOther: true,
            multiSelect: question.multiSelect,
            options: question.options.map(option => ({
              description: '',
              label: option.title || option.const,
              value: option.const,
            })),
            question: question.question,
          })),
        },
        interactionId: pending.interactionId,
        kind: 'question',
        nativeContext: {
          sessionId: request.sessionId,
          ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        },
        sessionInstanceId: this.sessionInstanceId,
        turnId,
      }, pending.signal);

      if (this.pending.isStaleResponse(pending, response) || this.getTurnId() !== turnId) {
        dismissReason = 'native-rejected';
        return CANCELLED;
      }
      dismissReason = 'resolved';
      if (!response.answers) return DECLINED;
      return buildElicitationResponse(questions, response.answers);
    } catch {
      return CANCELLED;
    } finally {
      this.pending.settle(pending, dismissReason);
      this.pending.release(pending);
    }
  }

  dismissAll(reason: ProviderInteractionDismissReason): void {
    this.pending.dismissAll(reason);
  }
}

function parseQuestions(request: ACPCreateElicitationRequest): VibeElicitationQuestion[] | null {
  const properties = request.requestedSchema?.properties;
  if (!properties || typeof properties !== 'object') return null;
  const questions: VibeElicitationQuestion[] = [];
  for (const [fieldId, property] of Object.entries(properties)) {
    if (!isElicitationProperty(property)) continue;
    const options = readOptions(property);
    const freeText = property.type === 'string' || property.type === 'number' || property.type === 'integer';
    if (options.length === 0 && !freeText) continue;
    questions.push({
      fieldId,
      header: property.title?.trim() || null,
      multiSelect: property.type === 'array',
      options,
      question: property.description?.trim() || request.message,
    });
  }
  return questions.length > 0 ? questions : null;
}

function isElicitationProperty(property: unknown): property is ACPElicitationProperty {
  return typeof property === 'object' && property !== null && typeof (property as ACPElicitationProperty).type === 'string';
}

function readOptions(property: ACPElicitationProperty): ACPElicitationEnumOption[] {
  const fromEnum = (property.enum ?? property.items?.enum)?.map(value => ({ const: value }));
  return (property.oneOf ?? property.items?.oneOf ?? property.items?.anyOf ?? fromEnum ?? [])
    .filter(option => typeof option?.const === 'string');
}

/** Answers carry option consts; free text passes through unchanged. */
function buildElicitationResponse(
  questions: readonly VibeElicitationQuestion[],
  answers: AskUserAnswers,
): ACPCreateElicitationResponse {
  const content: Record<string, string | string[]> = {};
  for (const question of questions) {
    const raw = answers[question.fieldId] ?? answers[question.question];
    if (raw === undefined) continue;
    const values = (Array.isArray(raw) ? raw : [raw])
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => question.options.find(option => option.const === value)?.const
        ?? question.options.find(option => option.title === value)?.const
        ?? value);
    if (values.length === 0) continue;
    content[question.fieldId] = question.multiSelect ? values : values.join(', ');
  }
  return { action: 'accept', content };
}
