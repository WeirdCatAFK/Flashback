/**
 * AnkiMappingModal — the field mapper shown between picking an .apkg and importing it.
 *
 * An Anki notetype declares arbitrary named fields and lets its templates decide
 * where each one renders; Flashback has five card types with fixed slots. That
 * projection used to happen invisibly. Here the user sees each notetype's real
 * fields with a sample note and drags them onto the card slots they should fill.
 *
 * The server has already done the reading (`POST /import/anki/analyze`) and holds
 * the extracted package under `report.sessionId`, so this component only edits a
 * mapping object and hands it back.
 *
 * Drag and drop is native HTML5 (`draggable` + `dataTransfer`), the same approach
 * FileExplorer uses — no DnD library.
 */

import { useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import Flashcard from './Flashcard.jsx';
import { previewCardFor } from './flashcardFields.js';
import { ankiSessionMediaSrc } from '../../api/documents.js';
import './AnkiMappingModal.css';

const CARD_TYPE_OPTIONS = [
    { key: 'basic', label: 'Basic' },
    { key: 'reversible', label: 'Reversible' },
    { key: 'cloze', label: 'Cloze' },
    { key: 'type_answer', label: 'Type answer' },
    { key: 'custom', label: 'Custom HTML' },
];

// Which slots a card type actually has, and what to call them for that type.
// Mirrors FlashcardForm's per-type fields so the mapper cannot offer a slot the
// card would then ignore.
const SLOTS_BY_TYPE = {
    basic: [
        { key: 'front', label: 'Front', hint: 'Question or prompt' },
        { key: 'back', label: 'Back', hint: 'Answer' },
    ],
    reversible: [
        { key: 'front', label: 'Term', hint: 'Asked in either direction' },
        { key: 'back', label: 'Definition', hint: 'Asked in either direction' },
    ],
    cloze: [
        { key: 'front', label: 'Cloze text', hint: '{{c1::…}} becomes {{…}}' },
    ],
    type_answer: [
        { key: 'front', label: 'Question', hint: 'Shown to the user' },
        { key: 'back', label: 'Expected answer', hint: 'Typed and checked' },
    ],
    custom: [],
};

// Media slots say *when* they fire, because that is the actual decision: front
// media appears with the question, back media with the revealed answer. For audio
// that is the difference between a listening prompt and a pronunciation reward.
const MEDIA_SLOTS = [
    { key: 'front_img', label: 'Front image', hint: 'with the question', opposite: 'back_img' },
    { key: 'front_sound', label: 'Front sound', hint: 'plays with the question', opposite: 'back_sound' },
    { key: 'back_img', label: 'Back image', hint: 'with the answer', opposite: 'front_img' },
    { key: 'back_sound', label: 'Back sound', hint: 'plays with the answer', opposite: 'front_sound' },
];

// type_answer has no media in FlashcardForm, and custom stores raw HTML.
const typeHasMedia = (cardType) => cardType === 'basic' || cardType === 'reversible' || cardType === 'cloze';

const ALL_SLOTS = ['front', 'back', 'front_img', 'front_sound', 'back_img', 'back_sound'];
const emptySlots = () => ({ front: [], back: [], front_img: [], front_sound: [], back_img: [], back_sound: [] });

const DRAG_MIME = 'application/x-flashback-anki-field';

/**
 * Strips tags and collapses whitespace so a sample value fits on a chip.
 *
 * Media is named rather than stripped: a field holding only `<img src="x.png">`
 * would otherwise render as an empty chip, making an image field look like a
 * field with nothing in it.
 */
function plainSample(value) {
    return String(value ?? '')
        .replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '🖼 $1')
        .replace(/\[sound:([^\]]+)\]/g, '🔊 $1')
        .replace(/<(?:audio|source|embed)[^>]*src=["']([^"']+)["'][^>]*>/gi, '🔊 $1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Anki keeps media inside the field HTML, so a field value has to be split into
// "text" and "the assets it names". Mirrors the rules ankiImport._applyMapping
// uses on the server — keep the two in step or the preview stops telling the truth.
const MEDIA_PATTERNS = [
    { kind: 'img', re: /<img[^>]+src=["']([^"']+)["'][^>]*>/gi },
    { kind: 'snd', re: /\[sound:([^\]]+)\]/gi },
    { kind: 'snd', re: /<(?:audio|source|embed)[^>]+src=["']([^"']+)["'][^>]*>/gi },
];

function extractMediaRefs(text) {
    const imgs = [];
    const snds = [];
    for (const { kind, re } of MEDIA_PATTERNS) {
        for (const match of String(text ?? '').matchAll(re)) {
            (kind === 'img' ? imgs : snds).push(match[1]);
        }
    }
    return { imgs, snds };
}

/**
 * Text a field contributes to a *text* slot, as the server will store it.
 *
 * Unlike plainSample this drops media references rather than naming them: the
 * server lifts them out into the media slots, so leaving "🖼 x.png" in here would
 * show text on the preview that the imported card will not have.
 */
function previewText(value) {
    let out = String(value ?? '');
    for (const { re } of MEDIA_PATTERNS) out = out.replace(re, ' ');
    return out
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export default function AnkiMappingModal({ report, filename, onCancel, onConfirm, importing = false, error = null }) {
    const notetypes = report?.notetypes ?? [];
    const [activeId, setActiveId] = useState(notetypes[0]?.id ?? null);
    const [sampleIndex, setSampleIndex] = useState(0);
    const [face, setFace] = useState('front');

    // Seeded from the server's suggestion, which is read back out of the notetype's
    // own templates — a well-formed Basic deck needs no edits at all.
    const [mappings, setMappings] = useState(() => {
        const seed = {};
        for (const nt of notetypes) {
            seed[nt.id] = {
                cardType: nt.suggested?.cardType ?? 'basic',
                slots: { ...emptySlots(), ...(nt.suggested?.slots ?? {}) },
            };
        }
        return seed;
    });

    const active = notetypes.find(nt => nt.id === activeId) ?? notetypes[0];
    const mapping = active ? mappings[active.id] : null;

    const assignedNames = useMemo(() => {
        if (!mapping) return new Set();
        return new Set(ALL_SLOTS.flatMap(slot => mapping.slots[slot] ?? []));
    }, [mapping]);

    if (!active || !mapping) return null;

    const sample = active.samples?.[sampleIndex] ?? [];
    const valueOf = (fieldName) => {
        const ord = active.fields.findIndex(f => f.name === fieldName);
        return ord >= 0 ? sample[ord] ?? '' : '';
    };

    /** Moves a field to `toSlot`, or back to the palette when `toSlot` is null. */
    const moveField = (fieldName, toSlot) => {
        setMappings(prev => {
            const current = prev[active.id];
            const slots = {};
            for (const slot of ALL_SLOTS) {
                slots[slot] = (current.slots[slot] ?? []).filter(n => n !== fieldName);
            }
            if (toSlot) slots[toSlot] = [...slots[toSlot], fieldName];
            return { ...prev, [active.id]: { ...current, slots } };
        });
    };

    const setCardType = (cardType) => {
        setMappings(prev => {
            const current = prev[active.id];
            const allowed = new Set([
                ...SLOTS_BY_TYPE[cardType].map(s => s.key),
                ...(typeHasMedia(cardType) ? MEDIA_SLOTS.map(s => s.key) : []),
            ]);
            // Fields sitting in a slot the new type doesn't have go back to the
            // palette rather than being silently imported into nothing.
            const slots = emptySlots();
            for (const slot of ALL_SLOTS) {
                if (allowed.has(slot)) slots[slot] = [...(current.slots[slot] ?? [])];
            }
            return { ...prev, [active.id]: { cardType, slots } };
        });
        setFace('front');
    };

    const onDragStart = (e, fieldName) => {
        e.dataTransfer.setData(DRAG_MIME, fieldName);
        e.dataTransfer.effectAllowed = 'move';
    };
    const dropHandlers = (slot) => ({
        onDragOver: (e) => {
            if (e.dataTransfer.types.includes(DRAG_MIME)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            }
        },
        onDrop: (e) => {
            const fieldName = e.dataTransfer.getData(DRAG_MIME);
            if (!fieldName) return;
            e.preventDefault();
            moveField(fieldName, slot);
        },
    });

    const chip = (fieldName, slot, opposite = null) => (
        <span
            key={fieldName}
            className="anki-map__chip"
            draggable
            onDragStart={(e) => onDragStart(e, fieldName)}
            title={plainSample(valueOf(fieldName)) || 'Empty in this sample note'}
        >
            <span className="anki-map__chip-name">{fieldName}</span>
            <span className="anki-map__chip-sample">{plainSample(valueOf(fieldName)).slice(0, 40) || '—'}</span>
            {/* Swapping a sound between question and answer is the single most likely
                edit here, and dragging across the panel to do it is needless work. */}
            {opposite && (
                <button
                    type="button"
                    className="anki-map__chip-swap"
                    onClick={() => moveField(fieldName, opposite)}
                    aria-label={`Move ${fieldName} to the other side`}
                    title="Move to the other side"
                >
                    ⇄
                </button>
            )}
            <button
                type="button"
                className="anki-map__chip-remove"
                onClick={() => moveField(fieldName, null)}
                aria-label={slot ? `Unassign ${fieldName}` : `Remove ${fieldName}`}
            >
                ×
            </button>
        </span>
    );

    const unassigned = active.fields.filter(f => !assignedNames.has(f.name));

    // The preview is the real card component fed through the same helper the card
    // form uses, so what is shown here cannot drift from what gets stored.
    const joined = (slot) => (mapping.slots[slot] ?? [])
        .map(n => previewText(valueOf(n)))
        .filter(Boolean)
        .join('\n\n');

    const previewFields = {
        front: joined('front'),
        back: joined('back'),
        clozeText: joined('front').replace(/\{\{c\d+::([^:}]+)(?:::[^}]*)?\}\}/g, '{{$1}}'),
        question: joined('front'),
        expectedAnswer: joined('back'),
        customHtml: '(kept as the original Anki HTML)',
    };

    // Resolve each media slot to a playable URL served straight out of the analyze
    // session, so images show and sounds can be heard *before* importing — which is
    // the only way to judge whether a sound belongs on the question or the answer.
    // Explicit media slots win over media that merely sits inside a text field,
    // matching _applyMapping.
    const rawOf = (slot) => (mapping.slots[slot] ?? []).map(n => valueOf(n)).join('\n');
    const mediaRefFor = (slot) => {
        const kind = slot.endsWith('_img') ? 'imgs' : 'snds';
        const explicit = extractMediaRefs(rawOf(slot))[kind][0];
        if (explicit) return explicit;
        const side = slot.startsWith('front') ? 'front' : 'back';
        return extractMediaRefs(rawOf(side))[kind][0] ?? null;
    };

    const previewMedia = {};
    for (const slot of ['front_img', 'front_sound', 'back_img', 'back_sound']) {
        const ref = mediaRefFor(slot);
        previewMedia[slot] = ref ? ankiSessionMediaSrc(report.sessionId, ref) : null;
    }

    const previewCard = previewCardFor(mapping.cardType, previewFields, previewMedia);
    const hasPreviewMedia = Object.values(previewMedia).some(Boolean);

    const totalCards = notetypes.reduce((sum, nt) => sum + (nt.noteCount ?? 0), 0);

    return (
        <Modal
            title="Import Anki deck"
            size="xl"
            dismissible={!importing}
            onClose={onCancel}
            footer={
                <div className="anki-map__footer">
                    <span className="anki-map__count">
                        {totalCards} card{totalCards === 1 ? '' : 's'} from {notetypes.length} note type{notetypes.length === 1 ? '' : 's'}
                    </span>
                    <div className="anki-map__footer-actions">
                        <button type="button" className="anki-map__btn" onClick={onCancel} disabled={importing}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="anki-map__btn anki-map__btn--primary"
                            onClick={() => onConfirm(mappings)}
                            disabled={importing}
                        >
                            {importing ? 'Importing…' : `Import ${totalCards} card${totalCards === 1 ? '' : 's'}`}
                        </button>
                    </div>
                </div>
            }
        >
            <div className="anki-map">
                <p className="anki-map__intro">
                    {filename ? <strong>{filename}</strong> : 'This deck'} uses Anki note types, which have
                    their own fields. Drag each field onto the part of the Flashback card it should become.
                    Fields left on the left are not imported.
                </p>

                {error && <div className="anki-map__error">{error}</div>}

                {notetypes.length > 1 && (
                    <div className="anki-map__tabs" role="tablist">
                        {notetypes.map(nt => (
                            <button
                                key={nt.id}
                                type="button"
                                role="tab"
                                aria-selected={nt.id === active.id}
                                className={`anki-map__tab${nt.id === active.id ? ' is-active' : ''}`}
                                onClick={() => { setActiveId(nt.id); setSampleIndex(0); setFace('front'); }}
                            >
                                {nt.name}
                                <span className="anki-map__tab-count">{nt.noteCount}</span>
                            </button>
                        ))}
                    </div>
                )}

                <div className="anki-map__grid">
                    <div className="anki-map__palette" {...dropHandlers(null)}>
                        <div className="anki-map__section-title">
                            Anki fields
                            {active.samples?.length > 1 && (
                                <button
                                    type="button"
                                    className="anki-map__sample-cycle"
                                    onClick={() => setSampleIndex(i => (i + 1) % active.samples.length)}
                                >
                                    sample {sampleIndex + 1}/{active.samples.length}
                                </button>
                            )}
                        </div>
                        <div className="anki-map__palette-list">
                            {unassigned.length === 0 && (
                                <p className="anki-map__empty">Every field is mapped.</p>
                            )}
                            {unassigned.map(f => chip(f.name, null))}
                        </div>
                        {unassigned.length > 0 && (
                            <p className="anki-map__note">These will be dropped.</p>
                        )}
                    </div>

                    <div className="anki-map__target">
                        <label className="anki-map__section-title" htmlFor="anki-map-type">
                            Becomes a
                            <select
                                id="anki-map-type"
                                className="anki-map__select"
                                value={mapping.cardType}
                                onChange={(e) => setCardType(e.target.value)}
                            >
                                {CARD_TYPE_OPTIONS.map(o => (
                                    <option key={o.key} value={o.key}>{o.label}</option>
                                ))}
                            </select>
                            card
                        </label>

                        {mapping.cardType === 'custom' ? (
                            <p className="anki-map__note anki-map__note--block">
                                Custom cards keep the note&apos;s original Anki HTML exactly as it
                                renders, so there is nothing to map. Media is still imported.
                            </p>
                        ) : (
                            <div className="anki-map__slots">
                                {SLOTS_BY_TYPE[mapping.cardType].map(slot => (
                                    <div key={slot.key} className="anki-map__slot" {...dropHandlers(slot.key)}>
                                        <div className="anki-map__slot-head">
                                            <span className="anki-map__slot-label">{slot.label}</span>
                                            <span className="anki-map__slot-hint">{slot.hint}</span>
                                        </div>
                                        <div className="anki-map__slot-body">
                                            {(mapping.slots[slot.key] ?? []).length === 0 && (
                                                <span className="anki-map__dropzone">Drop a field here</span>
                                            )}
                                            {(mapping.slots[slot.key] ?? []).map(n => chip(n, slot.key))}
                                        </div>
                                    </div>
                                ))}

                                {typeHasMedia(mapping.cardType) && (
                                    <div className="anki-map__media">
                                        {MEDIA_SLOTS
                                            .filter(m => mapping.cardType !== 'cloze' || m.key.startsWith('front'))
                                            .map(m => (
                                                <div key={m.key} className="anki-map__slot anki-map__slot--media" {...dropHandlers(m.key)}>
                                                    <div className="anki-map__slot-head">
                                                        <span className="anki-map__slot-label">{m.label}</span>
                                                        <span className="anki-map__slot-hint">{m.hint}</span>
                                                    </div>
                                                    <div className="anki-map__slot-body">
                                                        {(mapping.slots[m.key] ?? []).length === 0 && (
                                                            <span className="anki-map__dropzone">optional</span>
                                                        )}
                                                        {/* Cloze only has front slots, so there is no other side to swap to. */}
                                                        {(mapping.slots[m.key] ?? []).map(n =>
                                                            chip(n, m.key, mapping.cardType === 'cloze' ? null : m.opposite))}
                                                    </div>
                                                </div>
                                            ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="anki-map__preview">
                        <div className="anki-map__section-title">
                            Preview
                            {mapping.cardType !== 'custom' && (
                                <button
                                    type="button"
                                    className="anki-map__sample-cycle"
                                    onClick={() => setFace(f => (f === 'front' ? 'back' : 'front'))}
                                >
                                    {face === 'front' ? 'show back' : 'show front'}
                                </button>
                            )}
                        </div>
                        <div className="anki-map__preview-card">
                            <div className="anki-map__preview-stage">
                                {/* autoplayAudio: flipping the preview should sound like a real
                                    review does, which is the whole point of choosing a side. */}
                                <Flashcard card={previewCard} variant="static" face={face} autoplayAudio />
                            </div>
                        </div>
                        <p className="anki-map__note">
                            {hasPreviewMedia
                                ? 'Flip the preview to hear which side the sound plays on.'
                                : 'No image or sound mapped for this note type.'}
                        </p>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
