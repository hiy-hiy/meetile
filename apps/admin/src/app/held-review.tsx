'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdminHeldDetail,
  AdminHeldItem,
} from '@puzzle-sns/functions/server/held-review';
import { api, time } from './client';

const blockedText: Record<NonNullable<AdminHeldDetail['blocked']>, string> = {
  decided: '判断済みです。',
  'day-ended':
    '撮影した日が終わったため、公開できません。公開しない判断だけを記録できます。',
  subject:
    '撮影者が利用停止中または利用終了済みのため、公開できません。公開しない判断だけを記録できます。',
  state:
    '撮影の状態が変わったため、公開できません。公開しない判断だけを記録できます。',
};
function decisionText(decision: AdminHeldItem['decision']) {
  return decision === 'approve' ? '公開を許可' : '公開しない';
}

export function HeldReview({
  busy,
  work,
}: {
  busy: boolean;
  work: (action: () => Promise<void>) => Promise<void>;
}) {
  const [status, setStatus] = useState<'pending' | 'reviewed'>('pending');
  const [items, setItems] = useState<AdminHeldItem[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminHeldDetail | null>(null),
    [choice, setChoice] = useState<'approve' | 'reject' | null>(null),
    [note, setNote] = useState(''),
    [message, setMessage] = useState('');
  const pending = useRef<{
    requestId: string;
    caseId: string;
    decision: 'approve' | 'reject';
    note: string;
  } | null>(null);
  const generation = useRef(0);
  const close = useCallback(() => {
    generation.current++;
    setDetail(null);
    setChoice(null);
    setNote('');
    pending.current = null;
  }, []);
  const load = useCallback(
    async (next: 'pending' | 'reviewed', nextCursor?: string) => {
      const epoch = generation.current;
      const value = (await api(
        'op=held-list&status=' +
          next +
          (nextCursor ? '&cursor=' + nextCursor : ''),
      )) as { items: AdminHeldItem[]; nextCursor: string | null };
      if (epoch !== generation.current) return;
      setItems((old) => (nextCursor ? [...old, ...value.items] : value.items));
      setCursor(value.nextCursor);
    },
    [],
  );
  useEffect(() => {
    void work(() => load('pending'));
    // Load once when the area opens; later loads are explicit.
  }, []);
  const caseId = detail?.item.caseId;
  useEffect(() => {
    if (!caseId) return;
    let active = true;
    // Keep publication eligibility current (the 4 a.m. boundary, suspension).
    const timer = setInterval(() => {
      const epoch = generation.current;
      void api('op=held-detail&caseId=' + caseId)
        .then((fresh) => {
          if (active && epoch === generation.current)
            setDetail(fresh as AdminHeldDetail);
        })
        .catch(() => {
          if (active) close();
        });
    }, 10000);
    const visibility = () => {
      if (document.visibilityState === 'hidden') close();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [caseId, close]);
  async function open(value: AdminHeldItem) {
    close();
    const epoch = generation.current;
    const fresh = (await api(
      'op=held-detail&caseId=' + value.caseId,
    )) as AdminHeldDetail;
    if (epoch === generation.current) setDetail(fresh);
  }
  async function decide() {
    if (!detail || !choice || !note.trim()) return;
    if (
      !pending.current ||
      pending.current.caseId !== detail.item.caseId ||
      pending.current.decision !== choice ||
      pending.current.note !== note.trim()
    )
      pending.current = {
        requestId: crypto.randomUUID(),
        caseId: detail.item.caseId,
        decision: choice,
        note: note.trim(),
      };
    await api('op=held-decision', pending.current);
    const decided = pending.current.decision;
    close();
    await load(status);
    setMessage(
      decided === 'approve'
        ? '公開を許可し、撮影者のピースを作成しました。'
        : '公開しない判断を保存しました。撮影者は撮り直せます。',
    );
  }
  const run = (action: () => Promise<void>) =>
    work(async () => {
      setMessage('');
      try {
        await action();
      } catch (error) {
        close();
        throw error;
      }
    });
  return (
    <div className="workspace">
      <section className="queue panel">
        <div className="section-head">
          <h2>保留一覧</h2>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                close();
                await load(status);
              })
            }
          >
            更新
          </button>
        </div>
        <div className="tabs" aria-label="保留の確認状態">
          {(['pending', 'reviewed'] as const).map((value) => (
            <button
              key={value}
              aria-pressed={status === value}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setStatus(value);
                  close();
                  await load(value);
                })
              }
            >
              {value === 'pending' ? '確認待ち' : '判断済み'}
            </button>
          ))}
        </div>
        <div className="case-list">
          {items.length === 0 ? (
            <p className="empty">
              {status === 'pending'
                ? '確認待ちの保留はありません。'
                : '判断済みの保留はありません。'}
            </p>
          ) : (
            items.map((value) => (
              <button
                className={
                  'case ' + (caseId === value.caseId ? 'selected' : '')
                }
                key={value.caseId}
                disabled={busy}
                onClick={() => void run(() => open(value))}
              >
                <span>撮影日 {value.dayKey}</span>
                {value.heldAtMs !== null && (
                  <small>保留 {time(value.heldAtMs)}</small>
                )}
                {value.status === 'reviewed' && (
                  <span className="state">{decisionText(value.decision)}</span>
                )}
              </button>
            ))
          )}
        </div>
        {cursor && (
          <button
            disabled={busy}
            onClick={() => void run(() => load(status, cursor))}
          >
            続きを読み込む
          </button>
        )}
      </section>
      <section className="review panel" aria-label="保留の詳細">
        {message && (
          <p role="status" className="message">
            {message}
          </p>
        )}
        {!detail ? (
          <div className="placeholder">
            <span className="outline-piece" aria-hidden="true">
              ◇
            </span>
            <h2>確認する保留を選んでください</h2>
            <p>
              自動審査で判断できなかった写真と文章です。公開前のため、撮影者以外には見えていません。
            </p>
          </div>
        ) : (
          <>
            <div className="section-head">
              <div>
                <span className="kicker">
                  {detail.item.status === 'pending' ? '確認待ち' : '判断済み'}
                </span>
                <h2>撮影日 {detail.item.dayKey}</h2>
              </div>
              <button disabled={busy} onClick={close}>
                閉じる
              </button>
            </div>
            {detail.imageAvailable ? (
              <img
                className="preview"
                src={'/api/admin?op=held-image&caseId=' + detail.item.caseId}
                alt="保留中の写真"
              />
            ) : (
              <div className="blank-photo">
                <p>
                  公開を許可したため、確認用の写真は削除しました。公開後の写真は通報から確認します。
                </p>
              </div>
            )}
            <dl>
              <dt>その日の署名</dt>
              <dd>{detail.username || '署名なし'}</dd>
              <dt>キャプション</dt>
              <dd>{detail.caption || 'キャプションなし'}</dd>
            </dl>
            {detail.item.status === 'reviewed' ? (
              <div className="decision-record">
                <h3>保存した判断</h3>
                <p>{decisionText(detail.item.decision)}</p>
                {detail.item.reviewedAtMs !== null && (
                  <p>記録 {time(detail.item.reviewedAtMs)}</p>
                )}
                <p>{detail.item.note}</p>
              </div>
            ) : (
              <div className="decision">
                <h3>この写真の扱い</h3>
                <p className="sub">
                  公開を許可すると、自動審査の合格と同じく撮影者のピースになります。公開しない場合、撮影者はその日のうちに撮り直せます。
                </p>
                {detail.blocked && <p>{blockedText[detail.blocked]}</p>}
                {!choice ? (
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={busy || detail.blocked !== null}
                      onClick={() => {
                        setNote('');
                        setChoice('approve');
                      }}
                    >
                      公開を許可する
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => {
                        setNote('');
                        setChoice('reject');
                      }}
                    >
                      公開しない
                    </button>
                  </div>
                ) : (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(decide);
                    }}
                  >
                    <h4>
                      {choice === 'approve'
                        ? '公開を許可しますか？'
                        : '公開しない判断を記録しますか？'}
                    </h4>
                    <p>
                      {choice === 'approve'
                        ? '同じパズルの参加者に写真・署名・キャプションが見えるようになります。'
                        : '写真はピースになりません。確認用の写真と文章は保存期間の決定まで残ります。'}
                    </p>
                    <label>
                      判断の理由
                      <textarea
                        required
                        maxLength={500}
                        value={note}
                        disabled={busy}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="判断の根拠を記録してください。個人情報は書かないでください。"
                      />
                    </label>
                    <div className="actions">
                      <button
                        className={choice === 'approve' ? 'primary' : 'danger'}
                        type="submit"
                        disabled={
                          busy ||
                          !note.trim() ||
                          (choice === 'approve' && detail.blocked !== null)
                        }
                      >
                        {busy
                          ? '保存しています…'
                          : choice === 'approve'
                            ? '公開の許可を確定する'
                            : '公開しない判断を確定する'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setChoice(null);
                          pending.current = null;
                        }}
                      >
                        キャンセル
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
