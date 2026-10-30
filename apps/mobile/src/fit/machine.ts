import type { FitView } from '@puzzle-sns/contracts';

export type FitStage =
  | 'idle'
  | 'searching'
  | 'multiple'
  | 'conflict'
  | 'matched'
  | 'preview'
  | 'waiting'
  | 'merged'
  | 'not-merged'
  | 'board-changed'
  | 'already-connected'
  | 'partner-left'
  | 'timeout'
  | 'day-changed'
  | 'unavailable'
  | 'rate-limited'
  | 'not-ready';
export interface FitState {
  stage: FitStage;
  sessionId: string | null;
  /** not-merged reason or unavailable kind; never a counterpart identifier. */
  reason: string | null;
}
export type FitEvent =
  | { type: 'start' }
  | { type: 'leave' }
  | {
      type: 'unavailable';
      kind: 'unsupported' | 'permission' | 'bluetooth-off' | 'interrupted';
    }
  | { type: 'rate-limited' }
  | { type: 'not-ready' }
  | { type: 'verdict'; status: 'searching' | 'multiple' | 'near' }
  | { type: 'conflict' }
  | { type: 'already-connected' }
  | { type: 'matched'; sessionId: string }
  | { type: 'preview-ready' }
  | { type: 'confirmed' }
  | { type: 'progress'; view: FitView }
  | { type: 'timeout' }
  | { type: 'day-changed' };

export const INITIAL: FitState = {
  stage: 'idle',
  sessionId: null,
  reason: null,
};
const SEARCHING: FitStage[] = ['searching', 'multiple'];
const SESSION: FitStage[] = ['matched', 'preview', 'waiting'];
export const isActive = (stage: FitStage) =>
  SEARCHING.includes(stage) || SESSION.includes(stage);
const to = (
  state: FitState,
  stage: FitStage,
  extra: Partial<FitState> = {},
): FitState => ({ ...state, stage, ...extra });

/** Terminal stages only leave through `start` or `leave`; stale events never revive them. */
export function reduce(state: FitState, event: FitEvent): FitState {
  switch (event.type) {
    case 'start':
      return { stage: 'searching', sessionId: null, reason: null };
    case 'leave':
      return INITIAL;
    case 'unavailable':
      return isActive(state.stage) || state.stage === 'idle'
        ? to(state, 'unavailable', { reason: event.kind })
        : state;
    case 'rate-limited':
      return to(state, 'rate-limited');
    case 'not-ready':
      return to(state, 'not-ready');
    case 'verdict':
      if (state.stage === 'searching' && event.status === 'multiple')
        return to(state, 'multiple');
      if (state.stage === 'multiple' && event.status !== 'multiple')
        return to(state, 'searching');
      return state;
    case 'conflict':
      return SEARCHING.includes(state.stage) ? to(state, 'conflict') : state;
    case 'already-connected':
      return SEARCHING.includes(state.stage)
        ? to(state, 'already-connected')
        : state;
    case 'matched':
      return SEARCHING.includes(state.stage)
        ? to(state, 'matched', { sessionId: event.sessionId })
        : state;
    case 'preview-ready':
      return state.stage === 'matched' ? to(state, 'preview') : state;
    case 'confirmed':
      return state.stage === 'preview' ? to(state, 'waiting') : state;
    case 'progress': {
      if (
        !SESSION.includes(state.stage) ||
        event.view.sessionId !== state.sessionId
      )
        return state;
      switch (event.view.stage) {
        case 'merged':
          return to(state, 'merged');
        case 'not-merged':
          return to(
            state,
            event.view.boardChanged ? 'board-changed' : 'not-merged',
            { reason: event.view.reason },
          );
        case 'cancelled':
          return to(state, 'partner-left');
        case 'matched':
          return state;
      }
      return state;
    }
    case 'timeout':
      return SESSION.includes(state.stage) ? to(state, 'timeout') : state;
    case 'day-changed':
      return isActive(state.stage) ? to(state, 'day-changed') : state;
  }
}
