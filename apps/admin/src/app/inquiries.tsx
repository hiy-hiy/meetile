'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdminInquiry,
  AdminInquiryDetail,
} from '@puzzle-sns/functions/server/inquiries';
import { api, time } from './client';

const categories = {
  general: '一般の問い合わせ',
  deletion: '削除の請求',
  're-review': '措置の再確認の依頼',
  rights: '権利侵害の申告',
  'child-safety': '子どもの安全・重大事案',
  other: 'その他',
} as const;
const statuses = {
  open: '未着手',
  'in-progress': '対応中',
  closed: '完了',
} as const;
const resolutions = {
  answered: '回答した',
  'action-taken': '措置を行った',
  'no-action': '対応不要',
  'unable-to-verify': '確認できなかった',
} as const;
type Category = keyof typeof categories;
type Resolution = keyof typeof resolutions;
const contactWarning =
  '連絡先・氏名・学校名など個人を特定できる情報は書かないでください。連絡先は外部の受付窓口にだけ残します。';

export function Inquiries({
  busy,
  work,
}: {
  busy: boolean;
  work: (action: () => Promise<void>) => Promise<void>;
}) {
  const [status, setStatus] = useState<'active' | 'closed'>('active');
  const [items, setItems] = useState<AdminInquiry[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [detail, setDetail] = useState<AdminInquiryDetail | null>(null),
    [message, setMessage] = useState(''),
    [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{
    category: Category;
    externalRef: string;
    summary: string;
    linkedCaseId: string;
  }>({ category: 'general', externalRef: '', summary: '', linkedCaseId: '' });
  const [note, setNote] = useState(''),
    [caseId, setCaseId] = useState(''),
    [resolution, setResolution] = useState<Resolution | null>(null),
    [closeNote, setCloseNote] = useState('');
  // One request ID per unchanged submission, so a lost response can be resent safely.
  const pending = useRef<{ key: string; requestId: string } | null>(null);
  const requestId = (key: string) => {
    if (pending.current?.key !== key)
      pending.current = { key, requestId: crypto.randomUUID() };
    return pending.current.requestId;
  };
  const generation = useRef(0);
  const close = useCallback(() => {
    generation.current++;
    setDetail(null);
    setNote('');
    setCaseId('');
    setResolution(null);
    setCloseNote('');
    pending.current = null;
  }, []);
  const load = useCallback(
    async (next: 'active' | 'closed', nextCursor?: string) => {
      const epoch = generation.current;
      const value = (await api(
        'op=inquiry-list&status=' +
          next +
          (nextCursor ? '&cursor=' + nextCursor : ''),
      )) as { inquiries: AdminInquiry[]; nextCursor: string | null };
      if (epoch !== generation.current) return;
      setItems((old) =>
        nextCursor ? [...old, ...value.inquiries] : value.inquiries,
      );
      setCursor(value.nextCursor);
    },
    [],
  );
  useEffect(() => {
    void work(() => load('active'));
    // Load once when the area opens; later loads are explicit.
  }, []);
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === 'hidden') close();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, [close]);
  async function open(id: string) {
    close();
    setCreating(false);
    const epoch = generation.current;
    const fresh = (await api(
      'op=inquiry-detail&id=' + id,
    )) as AdminInquiryDetail;
    if (epoch === generation.current) setDetail(fresh);
  }
  const run = (action: () => Promise<void>) =>
    work(async () => {
      setMessage('');
      await action();
    });
  async function create() {
    const body = {
      category: form.category,
      summary: form.summary.trim(),
      ...(form.externalRef.trim()
        ? { externalRef: form.externalRef.trim() }
        : {}),
      ...(form.linkedCaseId.trim()
        ? { linkedCaseId: form.linkedCaseId.trim() }
        : {}),
    };
    const result = (await api('op=inquiry-create', {
      ...body,
      requestId: requestId('create:' + JSON.stringify(body)),
    })) as { id: string };
    pending.current = null;
    setCreating(false);
    setForm({
      category: 'general',
      externalRef: '',
      summary: '',
      linkedCaseId: '',
    });
    await load(status);
    await open(result.id);
    setMessage('問い合わせを登録しました。');
  }
  async function update(body: Record<string, string>, done: string) {
    if (!detail) return;
    const id = detail.inquiry.id;
    const value = { ...body, id };
    await api('op=inquiry-update', {
      ...value,
      requestId: requestId('update:' + JSON.stringify(value)),
    });
    pending.current = null;
    await load(status);
    await open(id);
    setMessage(done);
  }
  const inquiry = detail?.inquiry;
  return (
    <div className="workspace">
      <section className="queue panel">
        <div className="section-head">
          <h2>問い合わせ台帳</h2>
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              close();
              setCreating(true);
            }}
          >
            登録する
          </button>
        </div>
        <div className="tabs" aria-label="問い合わせの状態">
          {(['active', 'closed'] as const).map((value) => (
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
              {value === 'active' ? '未完了' : '完了'}
            </button>
          ))}
        </div>
        <div className="case-list">
          {items.length === 0 ? (
            <p className="empty">
              {status === 'active'
                ? '未完了の問い合わせはありません。'
                : '完了した問い合わせはありません。'}
            </p>
          ) : (
            items.map((value) => (
              <button
                key={value.id}
                className={
                  'case ' + (inquiry?.id === value.id ? 'selected' : '')
                }
                disabled={busy}
                onClick={() => void run(() => open(value.id))}
              >
                <span>{categories[value.category]}</span>
                <small>登録 {time(value.createdAtMs)}</small>
                <span className="state">
                  {statuses[value.status]}
                  {value.assignedToMe && ' · 自分が担当'}
                </span>
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
      <section className="review panel" aria-label="問い合わせの詳細">
        {message && (
          <p role="status" className="message">
            {message}
          </p>
        )}
        {creating ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(create);
            }}
          >
            <h2>問い合わせを登録する</h2>
            <p className="sub">
              外部の受付窓口に届いた問い合わせを記録します。{contactWarning}
            </p>
            <label>
              種類
              <select
                value={form.category}
                disabled={busy}
                onChange={(event) =>
                  setForm({
                    ...form,
                    category: event.target.value as Category,
                  })
                }
              >
                {Object.entries(categories).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              外部の受付番号（任意）
              <input
                maxLength={64}
                value={form.externalRef}
                disabled={busy}
                onChange={(event) =>
                  setForm({ ...form, externalRef: event.target.value })
                }
                placeholder="受付窓口側の番号。連絡先は書かないでください。"
              />
            </label>
            <label>
              内容の要約
              <textarea
                required
                maxLength={1000}
                value={form.summary}
                disabled={busy}
                onChange={(event) =>
                  setForm({ ...form, summary: event.target.value })
                }
              />
            </label>
            <label>
              関連する通報の案件番号（任意）
              <input
                value={form.linkedCaseId}
                disabled={busy}
                onChange={(event) =>
                  setForm({ ...form, linkedCaseId: event.target.value })
                }
                placeholder="通報の詳細に表示される64文字の番号"
              />
            </label>
            {form.category === 'deletion' && (
              <p>
                端末やアプリを失った人の削除請求は、本人を確認する仕組みがありません。対象を通報案件と結び付けられる場合だけ、その案件で全体非表示を検討してください。
              </p>
            )}
            {form.category === 'child-safety' && (
              <p>
                重大事案・CSAMの連絡・保全・報告の手順は未確定です。画像を台帳へ貼らず、確定済みの手順に従ってください。
              </p>
            )}
            <div className="actions">
              <button
                className="primary"
                type="submit"
                disabled={busy || !form.summary.trim()}
              >
                {busy ? '保存しています…' : '登録を確定する'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  pending.current = null;
                }}
              >
                キャンセル
              </button>
            </div>
          </form>
        ) : !inquiry || !detail ? (
          <div className="placeholder">
            <span className="outline-piece" aria-hidden="true">
              ◇
            </span>
            <h2>問い合わせを選ぶか、登録してください</h2>
            <p>{contactWarning}</p>
          </div>
        ) : (
          <>
            <div className="section-head">
              <div>
                <span className="kicker">{statuses[inquiry.status]}</span>
                <h2>{categories[inquiry.category]}</h2>
              </div>
              <button disabled={busy} onClick={close}>
                閉じる
              </button>
            </div>
            <p className="sub">
              登録 {time(inquiry.createdAtMs)}
              {inquiry.externalRef &&
                ` · 外部の受付番号 ${inquiry.externalRef}`}
            </p>
            <dl>
              <dt>内容の要約</dt>
              <dd>{inquiry.summary}</dd>
              <dt>担当</dt>
              <dd>
                {inquiry.assignedToMe
                  ? '自分'
                  : inquiry.assigned
                    ? '別の運営者'
                    : '未定'}
              </dd>
              <dt>関連する通報</dt>
              <dd>{inquiry.linkedCaseId ?? 'なし'}</dd>
            </dl>
            <div className="decision-record">
              <h3>対応メモ</h3>
              {detail.notes.length === 0 ? (
                <p>メモはありません。</p>
              ) : (
                <ul>
                  {detail.notes.map((value, index) => (
                    <li key={index}>
                      <small>
                        {time(value.atMs)}
                        {value.mine ? ' · 自分' : ''}
                      </small>
                      <p>{value.note}</p>
                    </li>
                  ))}
                </ul>
              )}
              {detail.moreNotes && <p>古い順に50件まで表示しています。</p>}
            </div>
            {inquiry.status === 'closed' ? (
              <div className="decision-record">
                <h3>完了</h3>
                <p>
                  {inquiry.resolution && resolutions[inquiry.resolution]}
                  {inquiry.closedAtMs !== null &&
                    ` · ${time(inquiry.closedAtMs)}`}
                </p>
                <p>{inquiry.resolutionNote}</p>
              </div>
            ) : (
              <div className="decision">
                <h3>対応</h3>
                {!inquiry.assignedToMe && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        update({ action: 'assign' }, '担当になりました。'),
                      )
                    }
                  >
                    {inquiry.assigned ? '担当を引き継ぐ' : '担当になる'}
                  </button>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await update(
                        { action: 'note', note: note.trim() },
                        'メモを追加しました。',
                      );
                      setNote('');
                    });
                  }}
                >
                  <label>
                    対応メモ
                    <textarea
                      maxLength={1000}
                      value={note}
                      disabled={busy}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder={contactWarning}
                    />
                  </label>
                  <button type="submit" disabled={busy || !note.trim()}>
                    メモを追加する
                  </button>
                </form>
                {!inquiry.linkedCaseId && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(() =>
                        update(
                          { action: 'link', caseId: caseId.trim() },
                          '通報案件と結び付けました。',
                        ),
                      );
                    }}
                  >
                    <label>
                      関連する通報の案件番号
                      <input
                        value={caseId}
                        disabled={busy}
                        onChange={(event) => setCaseId(event.target.value)}
                        placeholder="通報の詳細に表示される64文字の番号"
                      />
                    </label>
                    <button type="submit" disabled={busy || !caseId.trim()}>
                      結び付ける
                    </button>
                  </form>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!resolution) return;
                    void run(() =>
                      update(
                        {
                          action: 'close',
                          resolution,
                          note: closeNote.trim(),
                        },
                        '問い合わせを完了にしました。',
                      ),
                    );
                  }}
                >
                  <h4>完了にする</h4>
                  <p>
                    完了後は変更できません。同じ人から再度届いた場合は、新しく登録してください。
                  </p>
                  <fieldset disabled={busy}>
                    <legend>結果</legend>
                    {Object.entries(resolutions).map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="resolution"
                          checked={resolution === value}
                          onChange={() => setResolution(value as Resolution)}
                        />
                        {label}
                      </label>
                    ))}
                  </fieldset>
                  <label>
                    結果の記録
                    <textarea
                      maxLength={500}
                      value={closeNote}
                      disabled={busy}
                      onChange={(event) => setCloseNote(event.target.value)}
                      placeholder={contactWarning}
                    />
                  </label>
                  <button
                    className="primary"
                    type="submit"
                    disabled={busy || !resolution || !closeNote.trim()}
                  >
                    完了を確定する
                  </button>
                </form>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
