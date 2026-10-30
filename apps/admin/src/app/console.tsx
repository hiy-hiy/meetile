'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { reportReasons } from '@puzzle-sns/contracts';
import type {
  AdminReport,
  AdminReportDetail,
} from '@puzzle-sns/functions/server/admin-moderation';
import type { WebConfig } from '../server/config';
import { api, time } from './client';
import { HeldReview } from './held-review';
import { ReReview } from './re-review';
import { Inquiries } from './inquiries';

export function Console({
  mode,
  web,
}: {
  mode: 'local' | 'cloud';
  web: WebConfig | null;
}) {
  const [signedIn, setSignedIn] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [area, setArea] = useState<'reports' | 'held' | 'inquiries'>('reports');
  const [status, setStatus] = useState<'pending' | 'reviewed'>('pending');
  const [reports, setReports] = useState<AdminReport[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminReportDetail | null>(null),
    [choice, setChoice] = useState<'dismiss' | 'remove' | 'suspend' | null>(
      null,
    ),
    [note, setNote] = useState('');
  const pending = useRef<{
    requestId: string;
    caseId: string;
    decision: 'dismiss' | 'remove';
    note: string;
  } | null>(null);
  const pendingSuspension = useRef<{
    requestId: string;
    caseId: string;
    note: string;
  } | null>(null);
  const generation = useRef(0);
  const working = useRef(false);
  const clearPrivate = useCallback(() => {
    generation.current++;
    setDetail(null);
    setReports([]);
    setChoice(null);
    setNote('');
    setSignedIn(false);
    pending.current = null;
    pendingSuspension.current = null;
  }, []);
  const load = useCallback(
    async (nextStatus: 'pending' | 'reviewed', nextCursor?: string) => {
      const epoch = generation.current;
      const value = (await api(
        'op=list&status=' +
          nextStatus +
          (nextCursor ? '&cursor=' + nextCursor : ''),
      )) as { reports: AdminReport[]; nextCursor: string | null };
      if (epoch !== generation.current) return;
      setReports((old) =>
        nextCursor ? [...old, ...value.reports] : value.reports,
      );
      setCursor(value.nextCursor);
      setSignedIn(true);
    },
    [],
  );
  useEffect(() => {
    void load('pending').catch(() => {});
  }, [load]);
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    const caseId = detail?.report.caseId;
    const check = async () => {
      if (working.current) return;
      const epoch = generation.current;
      try {
        if (caseId) {
          const fresh = (await api(
            'op=detail&caseId=' + caseId,
          )) as AdminReportDetail;
          if (active && epoch === generation.current)
            setDetail((current) =>
              current?.report.caseId === caseId ? fresh : current,
            );
        } else await api('op=session-check');
      } catch {
        if (active) {
          clearPrivate();
          setMessage('セッションを確認できません。再度ログインしてください。');
        }
      }
    };
    const timer = setInterval(
      () => {
        void check();
      },
      caseId ? 10000 : 30000,
    );
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        generation.current++;
        setDetail(null);
        setChoice(null);
        setNote('');
        pending.current = null;
        pendingSuspension.current = null;
      } else {
        void check();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [signedIn, clearPrivate, detail?.report.caseId]);
  useEffect(() => {
    if (choice === 'suspend' && detail?.subjectState !== 'active') {
      setChoice(null);
      setNote('');
      pendingSuspension.current = null;
    }
  }, [choice, detail?.subjectState]);
  async function work(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setDetail(null);
      setMessage(error instanceof Error ? error.message : '操作できません。');
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function login() {
    if (mode === 'local') await api('op=local-session', {});
    else {
      if (!web) throw new Error('ログイン設定を確認してください。');
      const [
        { initializeApp, getApps },
        {
          getAuth,
          setPersistence,
          inMemoryPersistence,
          GoogleAuthProvider,
          signInWithPopup,
          signOut,
        },
      ] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
      const app = getApps()[0] ?? initializeApp(web);
      const auth = getAuth(app);
      await setPersistence(auth, inMemoryPersistence);
      try {
        const credential = await signInWithPopup(
          auth,
          new GoogleAuthProvider(),
        );
        await api('op=session', {
          idToken: await credential.user.getIdToken(),
        });
      } finally {
        await signOut(auth);
      }
    }
    await load('pending');
    setStatus('pending');
  }
  async function open(report: AdminReport) {
    const epoch = ++generation.current;
    setDetail(null);
    setChoice(null);
    setNote('');
    pending.current = null;
    pendingSuspension.current = null;
    const value = (await api(
      'op=detail&caseId=' + report.caseId,
    )) as AdminReportDetail;
    if (epoch === generation.current) setDetail(value);
  }
  async function decide() {
    if (!detail || !choice || choice === 'suspend' || !note.trim()) return;
    if (
      !pending.current ||
      pending.current.caseId !== detail.report.caseId ||
      pending.current.decision !== choice ||
      pending.current.note !== note.trim()
    )
      pending.current = {
        requestId: crypto.randomUUID(),
        caseId: detail.report.caseId,
        decision: choice,
        note: note.trim(),
      };
    await api('op=decision', pending.current);
    pending.current = null;
    pendingSuspension.current = null;
    setDetail(null);
    setChoice(null);
    setNote('');
    await load(status);
    setMessage('判断を保存しました。');
  }
  async function suspend() {
    if (!detail || choice !== 'suspend' || !note.trim()) return;
    if (
      !pendingSuspension.current ||
      pendingSuspension.current.caseId !== detail.report.caseId ||
      pendingSuspension.current.note !== note.trim()
    )
      pendingSuspension.current = {
        requestId: crypto.randomUUID(),
        caseId: detail.report.caseId,
        note: note.trim(),
      };
    const epoch = ++generation.current;
    await api('op=suspend', pendingSuspension.current);
    if (epoch !== generation.current) return;
    const fresh = (await api(
      'op=detail&caseId=' + detail.report.caseId,
    )) as AdminReportDetail;
    if (epoch !== generation.current) return;
    setDetail(fresh);
    setChoice(null);
    setNote('');
    pendingSuspension.current = null;
    setMessage('対象者の利用を停止しました。');
  }
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">puzzle-sns / ADMIN</p>
          <h1>
            {
              {
                reports: '通報の確認',
                held: '投稿前の保留',
                inquiries: '問い合わせ',
              }[area]
            }
          </h1>
          <p className="sub">写真を確認し、必要な対応を記録します。</p>
        </div>
        <div className="header-actions">
          {mode === 'local' && (
            <span className="badge">ローカル検証・人工素材のみ</span>
          )}
          {signedIn && (
            <button
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  try {
                    await api('op=logout', {});
                  } finally {
                    clearPrivate();
                    setMessage('ログアウトしました。');
                  }
                })
              }
            >
              ログアウト
            </button>
          )}
        </div>
      </header>
      {message && (
        <p role="status" className="message">
          {message}
        </p>
      )}
      {!signedIn ? (
        <section className="login panel">
          <span className="kicker">運営者専用</span>
          <h2>ログインして確認を始める</h2>
          <p>許可された運営者だけが、通報と対象写真を確認できます。</p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void work(login)}
          >
            {busy
              ? '確認しています…'
              : mode === 'local'
                ? '検証用運営者でログイン'
                : 'Googleでログイン'}
          </button>
        </section>
      ) : (
        <>
          <div className="tabs" aria-label="確認する対象">
            {(['reports', 'held', 'inquiries'] as const).map((value) => (
              <button
                key={value}
                aria-pressed={area === value}
                disabled={busy}
                onClick={() => {
                  generation.current++;
                  setDetail(null);
                  setChoice(null);
                  setNote('');
                  pending.current = null;
                  pendingSuspension.current = null;
                  setArea(value);
                }}
              >
                {
                  {
                    reports: '通報',
                    held: '投稿前の保留',
                    inquiries: '問い合わせ',
                  }[value]
                }
              </button>
            ))}
          </div>
          {area === 'held' ? (
            <HeldReview busy={busy} work={work} />
          ) : area === 'inquiries' ? (
            <Inquiries busy={busy} work={work} />
          ) : (
            <div className="workspace">
              <section className="queue panel">
                <div className="section-head">
                  <h2>通報一覧</h2>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void work(async () => {
                        setDetail(null);
                        await load(status);
                      })
                    }
                  >
                    更新
                  </button>
                </div>
                <div className="tabs" aria-label="確認状態">
                  {(['pending', 'reviewed'] as const).map((value) => (
                    <button
                      key={value}
                      aria-pressed={status === value}
                      disabled={busy}
                      onClick={() =>
                        void work(async () => {
                          setStatus(value);
                          setDetail(null);
                          await load(value);
                        })
                      }
                    >
                      {value === 'pending' ? '確認待ち' : '対応済み'}
                    </button>
                  ))}
                </div>
                <div className="case-list">
                  {reports.length === 0 ? (
                    <p className="empty">
                      {status === 'pending'
                        ? '確認待ちの通報はありません。'
                        : '対応済みの通報はありません。'}
                    </p>
                  ) : (
                    reports.map((report) => (
                      <button
                        className={
                          'case ' +
                          (detail?.report.caseId === report.caseId
                            ? 'selected'
                            : '')
                        }
                        key={report.caseId}
                        disabled={busy}
                        onClick={() => void work(() => open(report))}
                      >
                        <span>{reportReasons[report.reason]}</span>
                        <small>受付 {time(report.createdAtMs)}</small>
                        <small>写真の日付 {report.dayKey}</small>
                        {report.status === 'reviewed' && (
                          <span className="state">
                            {report.decision === 'remove'
                              ? '全体非表示'
                              : '対応不要'}
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
                {cursor && (
                  <button
                    disabled={busy}
                    onClick={() => void work(() => load(status, cursor))}
                  >
                    続きを読み込む
                  </button>
                )}
              </section>
              <section className="review panel" aria-label="通報の詳細">
                {!detail ? (
                  <div className="placeholder">
                    <span className="outline-piece" aria-hidden="true">
                      ◇
                    </span>
                    <h2>確認する通報を選んでください</h2>
                    <p>写真・文章と、同じ写真への通報をここに表示します。</p>
                  </div>
                ) : (
                  <>
                    <div className="section-head">
                      <div>
                        <span className="kicker">
                          {detail.report.status === 'pending'
                            ? '確認待ち'
                            : '対応済み'}
                        </span>
                        <h2>{reportReasons[detail.report.reason]}</h2>
                      </div>
                      <button
                        disabled={busy}
                        onClick={() => {
                          setDetail(null);
                          setChoice(null);
                        }}
                      >
                        閉じる
                      </button>
                    </div>
                    <p className="sub">
                      写真の日付 {detail.report.dayKey} · 受付{' '}
                      {time(detail.report.createdAtMs)}
                      <br />
                      案件番号 <code>{detail.report.caseId}</code>
                    </p>
                    {detail.photoState === 'approved' ? (
                      <img
                        className="preview"
                        src={
                          '/api/admin?op=image&caseId=' + detail.report.caseId
                        }
                        alt="通報された写真"
                      />
                    ) : (
                      <div className="blank-photo">
                        <p>この写真は削除または非表示になっています。</p>
                      </div>
                    )}
                    <dl>
                      <dt>その日の署名</dt>
                      <dd>{detail.username || '署名なし'}</dd>
                      <dt>キャプション</dt>
                      <dd>{detail.caption || 'キャプションなし'}</dd>
                    </dl>
                    <details>
                      <summary>
                        同じ写真への通報 ({detail.related.length}
                        {detail.moreRelated ? '件以上' : '件'})
                      </summary>
                      <ul>
                        {detail.related.map((report) => (
                          <li key={report.caseId}>
                            {reportReasons[report.reason]}{' '}
                            <small>
                              {time(report.createdAtMs)} ·{' '}
                              {report.status === 'pending'
                                ? '確認待ち'
                                : '対応済み'}
                            </small>
                          </li>
                        ))}
                      </ul>
                    </details>
                    {detail.report.status === 'reviewed' ? (
                      <div className="decision-record">
                        <h3>保存した判断</h3>
                        <p>
                          {detail.report.decision === 'remove'
                            ? '全体非表示'
                            : '対応不要'}
                        </p>
                        <p>{detail.report.note}</p>
                      </div>
                    ) : (
                      <div className="decision">
                        <h3>この通報への対応</h3>
                        <p className="sub">
                          全体非表示にすると、全参加者から写真・署名・キャプションを消し、ピースの形と配置を残します。
                        </p>
                        {!choice || choice === 'suspend' ? (
                          <div className="actions">
                            <button
                              disabled={busy || choice === 'suspend'}
                              onClick={() => {
                                setNote('');
                                setChoice('dismiss');
                              }}
                            >
                              対応不要として記録
                            </button>
                            <button
                              className="danger"
                              disabled={busy || choice === 'suspend'}
                              onClick={() => {
                                setNote('');
                                setChoice('remove');
                              }}
                            >
                              全体非表示にする
                            </button>
                          </div>
                        ) : (
                          <form
                            onSubmit={(event) => {
                              event.preventDefault();
                              void work(decide);
                            }}
                          >
                            <h4>
                              {choice === 'remove'
                                ? '全体非表示にしますか？'
                                : '対応不要として記録しますか？'}
                            </h4>
                            {choice === 'remove' && (
                              <p>
                                写真は元に戻せません。既に保存・共有された画像は回収できません。
                              </p>
                            )}
                            <label>
                              判断の理由
                              <textarea
                                required
                                maxLength={500}
                                value={note}
                                disabled={busy}
                                onChange={(event) =>
                                  setNote(event.target.value)
                                }
                                placeholder="判断の根拠を記録してください。個人情報は書かないでください。"
                              />
                            </label>
                            <div className="actions">
                              <button
                                className={
                                  choice === 'remove' ? 'danger' : 'primary'
                                }
                                disabled={busy || !note.trim()}
                                type="submit"
                              >
                                {busy
                                  ? '保存しています…'
                                  : choice === 'remove'
                                    ? '全体非表示を確定する'
                                    : '対応不要を確定する'}
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  setChoice(null);
                                  pending.current = null;
                                  pendingSuspension.current = null;
                                }}
                              >
                                キャンセル
                              </button>
                            </div>
                          </form>
                        )}
                      </div>
                    )}
                    <div className="decision">
                      <h3>対象者の利用停止</h3>
                      {detail.subjectState === 'suspended' ? (
                        <div className="decision-record">
                          <p>対象者は利用停止中です。</p>
                          {detail.suspension && (
                            <>
                              <p>記録 {time(detail.suspension.atMs)}</p>
                              <p>{detail.suspension.note}</p>
                            </>
                          )}
                        </div>
                      ) : detail.subjectState !== 'active' ? (
                        <p>対象者の利用状態を変更できません。</p>
                      ) : choice === 'suspend' ? (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            void work(suspend);
                          }}
                        >
                          <h4>対象者の利用を停止しますか？</h4>
                          <p>
                            対象者の撮影・FIT・パズルと写真の取得を停止します。写真を全参加者から非表示にする場合は、写真の全体非表示も行ってください。
                          </p>
                          <label>
                            停止の理由
                            <textarea
                              required
                              maxLength={500}
                              value={note}
                              disabled={busy}
                              onChange={(event) => setNote(event.target.value)}
                              placeholder="停止の根拠を記録してください。個人情報は書かないでください。"
                            />
                          </label>
                          <div className="actions">
                            <button
                              className="danger"
                              type="submit"
                              disabled={busy || !note.trim()}
                            >
                              {busy ? '保存しています…' : '利用停止を確定する'}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setChoice(null);
                                setNote('');
                                pendingSuspension.current = null;
                              }}
                            >
                              キャンセル
                            </button>
                          </div>
                        </form>
                      ) : (
                        <button
                          className="danger"
                          disabled={busy || choice !== null}
                          onClick={() => {
                            setNote('');
                            setChoice('suspend');
                          }}
                        >
                          対象者を利用停止にする
                        </button>
                      )}
                    </div>
                    <ReReview
                      detail={detail}
                      busy={busy}
                      locked={choice !== null}
                      work={work}
                      onRecorded={(fresh, text) => {
                        setDetail((current) =>
                          current?.report.caseId === fresh.report.caseId
                            ? fresh
                            : current,
                        );
                        setMessage(text);
                      }}
                    />
                  </>
                )}
              </section>
            </div>
          )}
        </>
      )}
      <footer>
        運営者向けの確認画面です。閲覧・判断は監査記録に保存されます。
      </footer>
    </main>
  );
}
