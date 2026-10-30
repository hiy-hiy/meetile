'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  AdminReportDetail,
  AdminReReview,
} from '@puzzle-sns/functions/server/admin-moderation';
import { api, time } from './client';

type Target = 'decision' | 'suspension';
type Outcome = 'upheld' | 'overturned';
const originalText: Record<AdminReReview['original'], string> = {
  dismiss: '対応不要',
  remove: '全体非表示',
  suspension: '利用停止',
};
// What "overturned" does for each original action; only a dismissal changes state.
const overturnText: Record<AdminReReview['original'], string> = {
  dismiss:
    '誤りとすると、写真を全体非表示にします。全参加者から写真・署名・キャプションを消し、元に戻せません。',
  remove: '誤りとして記録します。画像は削除済みのため、写真は元に戻りません。',
  suspension:
    '誤りとして記録します。利用停止の解除は行いません（解除の機能はありません）。',
};

export function ReReview({
  detail,
  busy,
  locked,
  work,
  onRecorded,
}: {
  detail: AdminReportDetail;
  busy: boolean;
  /** Another decision form on the same case is open. */
  locked: boolean;
  work: (action: () => Promise<void>) => Promise<void>;
  onRecorded: (fresh: AdminReportDetail, message: string) => void;
}) {
  const [target, setTarget] = useState<Target | null>(null),
    [outcome, setOutcome] = useState<Outcome | null>(null),
    [note, setNote] = useState('');
  const pending = useRef<{
    caseId: string;
    requestId: string;
    target: Target;
    outcome: Outcome;
    note: string;
  } | null>(null);
  const caseId = detail.report.caseId;
  useEffect(() => {
    setTarget(null);
    setOutcome(null);
    setNote('');
    pending.current = null;
  }, [caseId]);
  const targets: {
    target: Target;
    original: AdminReReview['original'] | null;
    review: AdminReReview | null;
    own: boolean;
  }[] = [
    {
      target: 'decision',
      original:
        detail.report.status === 'reviewed'
          ? (detail.report.decision ?? null)
          : null,
      review: detail.reReviews.decision,
      own: detail.ownDecision,
    },
    {
      target: 'suspension',
      original: detail.suspension ? 'suspension' : null,
      review: detail.reReviews.suspension,
      own: detail.ownSuspension,
    },
  ];
  async function record() {
    if (!target || !outcome || !note.trim()) return;
    const value = {
      caseId,
      target,
      outcome,
      note: note.trim(),
    };
    if (
      !pending.current ||
      pending.current.caseId !== value.caseId ||
      pending.current.target !== value.target ||
      pending.current.outcome !== value.outcome ||
      pending.current.note !== value.note
    )
      pending.current = { ...value, requestId: crypto.randomUUID() };
    const result = (await api('op=rereview', pending.current)) as {
      effect: 'none' | 'removed';
    };
    pending.current = null;
    const fresh = (await api(
      'op=detail&caseId=' + caseId,
    )) as AdminReportDetail;
    setTarget(null);
    setOutcome(null);
    setNote('');
    onRecorded(
      fresh,
      result.effect === 'removed'
        ? '再確認を記録し、写真を全体非表示にしました。'
        : '再確認を記録しました。',
    );
  }
  if (targets.every((value) => value.original === null)) return null;
  return (
    <div className="decision">
      <h3>判断の再確認</h3>
      <p className="sub">
        元の判断をした運営者以外が見直します。元の記録は変更しません。再確認は対象ごとに1回です。
      </p>
      {targets.map(({ target: value, original, review, own }) =>
        original === null ? null : (
          <div key={value} className="decision-record">
            <h4>
              {value === 'decision' ? '通報への判断' : '利用停止'}（
              {originalText[original]}）
            </h4>
            {review ? (
              <>
                <p>
                  {review.outcome === 'upheld' ? '判断を維持' : '誤りと確認'} ·
                  記録 {time(review.atMs)}
                  {review.effect === 'removed' && ' · 全体非表示に変更'}
                </p>
                <p>{review.note}</p>
              </>
            ) : own ? (
              <p>元の判断をしたため、この運営者は再確認できません。</p>
            ) : target === value ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void work(record);
                }}
              >
                <fieldset disabled={busy}>
                  <legend>見直しの結果</legend>
                  {(['upheld', 'overturned'] as const).map((choice) => (
                    <label key={choice}>
                      <input
                        type="radio"
                        name={'rereview-' + value}
                        checked={outcome === choice}
                        onChange={() => {
                          setOutcome(choice);
                          pending.current = null;
                        }}
                      />
                      {choice === 'upheld' ? '判断を維持する' : '誤りだった'}
                    </label>
                  ))}
                </fieldset>
                {outcome === 'overturned' && <p>{overturnText[original]}</p>}
                <label>
                  再確認の理由
                  <textarea
                    required
                    maxLength={500}
                    value={note}
                    disabled={busy}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="見直しの根拠を記録してください。個人情報は書かないでください。"
                  />
                </label>
                <div className="actions">
                  <button
                    type="submit"
                    className={
                      outcome === 'overturned' && original === 'dismiss'
                        ? 'danger'
                        : 'primary'
                    }
                    disabled={busy || !outcome || !note.trim()}
                  >
                    {busy ? '保存しています…' : '再確認を確定する'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setTarget(null);
                      setOutcome(null);
                      setNote('');
                      pending.current = null;
                    }}
                  >
                    キャンセル
                  </button>
                </div>
              </form>
            ) : (
              <button
                disabled={busy || locked || target !== null}
                onClick={() => {
                  setTarget(value);
                  setOutcome(null);
                  setNote('');
                }}
              >
                再確認する
              </button>
            )}
          </div>
        ),
      )}
    </div>
  );
}
