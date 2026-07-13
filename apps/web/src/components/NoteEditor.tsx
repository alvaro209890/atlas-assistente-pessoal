import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mark, markInputRule, mergeAttributes } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import TurndownService from 'turndown';
import {
  Bold,
  Braces,
  Check,
  Code2,
  Heading2,
  Italic,
  List,
  ListOrdered,
  LoaderCircle,
  Quote,
  Redo2,
  Save,
  Sparkles,
  Undo2,
} from 'lucide-react';
import type { Note } from '../types';

const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!);

const WikiLink = Mark.create({
  name: 'wikilink',
  inclusive: false,
  addAttributes() {
    return {
      target: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-wikilink'),
        renderHTML: (attributes) => ({ 'data-wikilink': attributes.target }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-wikilink]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'wiki-link' }), 0];
  },
  addInputRules() {
    return [
      markInputRule({
        find: /\[\[([^\]]+)\]\]$/,
        type: this.type,
        getAttributes: (match) => ({ target: match[1] }),
      }),
    ];
  },
});

function markdownToHtml(markdown: string) {
  const withWikiLinks = markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, target: string) => {
    const safe = escapeAttribute(target.trim());
    return `<span data-wikilink="${safe}">[[${safe}]]</span>`;
  });
  return DOMPurify.sanitize(String(marked.parse(withWikiLinks, { gfm: true, breaks: true })));
}

function createTurndown() {
  const service = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  service.addRule('wikilink', {
    filter: (node) => node instanceof HTMLElement && node.hasAttribute('data-wikilink'),
    replacement: (_content, node) => `[[${(node as HTMLElement).dataset.wikilink || node.textContent?.replace(/^\[\[|\]\]$/g, '') || ''}]]`,
  });
  return service;
}

interface NoteEditorProps {
  note: Note;
  onSave(id: string, input: { title: string; contentMarkdown: string }): Promise<Note>;
}

export function NoteEditor({ note, onSave }: NoteEditorProps) {
  const [title, setTitle] = useState(note.title);
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const turndown = useMemo(createTurndown, []);
  const titleRef = useRef(note.title);
  const htmlRef = useRef(markdownToHtml(note.contentMarkdown));
  const revisionRef = useRef(0);
  const persistedRevisionRef = useRef(0);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const flushRequestedRef = useRef(false);
  const mountedRef = useRef(true);
  const savedIndicatorTimerRef = useRef<number | null>(null);

  const markDirty = useCallback(() => {
    revisionRef.current += 1;
    setRevision(revisionRef.current);
    setSaveState('dirty');
  }, []);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        WikiLink,
        Placeholder.configure({ placeholder: 'Comece a escrever. Use [[duplo colchete]] para conectar uma ideia…' }),
      ],
      content: markdownToHtml(note.contentMarkdown),
      editorProps: {
        attributes: {
          class: 'note-prose',
          'aria-label': 'Conteúdo da nota',
        },
      },
      onUpdate: ({ editor: currentEditor }) => {
        htmlRef.current = currentEditor.getHTML();
        markDirty();
      },
    },
    [note.id],
  );

  useEffect(() => {
    setTitle(note.title);
    titleRef.current = note.title;
    htmlRef.current = markdownToHtml(note.contentMarkdown);
    revisionRef.current = 0;
    persistedRevisionRef.current = 0;
    flushRequestedRef.current = false;
    setRevision(0);
    setSaveState('idle');
  }, [note.id]);

  const save = useCallback(() => {
    flushRequestedRef.current = true;
    if (savePromiseRef.current) return savePromiseRef.current;

    const drain = async () => {
      while (flushRequestedRef.current || persistedRevisionRef.current < revisionRef.current) {
        flushRequestedRef.current = false;
        const snapshotRevision = revisionRef.current;
        const input = {
          title: titleRef.current.trim() || 'Sem título',
          contentMarkdown: turndown.turndown(htmlRef.current),
        };

        if (mountedRef.current) setSaveState('saving');
        try {
          await onSave(note.id, input);
        } catch {
          if (mountedRef.current) setSaveState('error');
          return;
        }

        persistedRevisionRef.current = Math.max(persistedRevisionRef.current, snapshotRevision);
        if (revisionRef.current > snapshotRevision) {
          flushRequestedRef.current = true;
          continue;
        }

        flushRequestedRef.current = false;
        if (mountedRef.current) {
          setSaveState('saved');
          if (savedIndicatorTimerRef.current !== null) window.clearTimeout(savedIndicatorTimerRef.current);
          savedIndicatorTimerRef.current = window.setTimeout(() => {
            if (mountedRef.current) setSaveState((current) => (current === 'saved' ? 'idle' : current));
          }, 1600);
        }
      }
    };

    const pending = drain().finally(() => {
      if (savePromiseRef.current === pending) savePromiseRef.current = null;
    });
    savePromiseRef.current = pending;
    return pending;
  }, [note.id, onSave, turndown]);

  useEffect(() => {
    if (!revision || revision <= persistedRevisionRef.current) return;
    const id = window.setTimeout(() => void save(), 1200);
    return () => window.clearTimeout(id);
  }, [revision, save]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (savedIndicatorTimerRef.current !== null) window.clearTimeout(savedIndicatorTimerRef.current);
      if (revisionRef.current > persistedRevisionRef.current) void save();
    };
  }, [save]);

  if (!editor) return <div className="editor-loading"><LoaderCircle size={18} /> Preparando editor…</div>;

  const toolbar = [
    { label: 'Negrito', icon: Bold, active: editor.isActive('bold'), action: () => editor.chain().focus().toggleBold().run() },
    { label: 'Itálico', icon: Italic, active: editor.isActive('italic'), action: () => editor.chain().focus().toggleItalic().run() },
    { label: 'Título', icon: Heading2, active: editor.isActive('heading', { level: 2 }), action: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: 'Lista', icon: List, active: editor.isActive('bulletList'), action: () => editor.chain().focus().toggleBulletList().run() },
    { label: 'Lista numerada', icon: ListOrdered, active: editor.isActive('orderedList'), action: () => editor.chain().focus().toggleOrderedList().run() },
    { label: 'Citação', icon: Quote, active: editor.isActive('blockquote'), action: () => editor.chain().focus().toggleBlockquote().run() },
    { label: 'Código', icon: Code2, active: editor.isActive('codeBlock'), action: () => editor.chain().focus().toggleCodeBlock().run() },
  ];

  return (
    <article className="note-editor" onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    }}>
      <header className="note-editor__header">
        <input className="note-title-input" value={title} onChange={(event) => { titleRef.current = event.target.value; setTitle(event.target.value); markDirty(); }} aria-label="Título da nota" />
        <div className={`save-indicator save-indicator--${saveState}`}>
          {saveState === 'saving' ? <LoaderCircle size={13} /> : saveState === 'saved' ? <Check size={13} /> : saveState === 'error' ? <span>!</span> : <Save size={13} />}
          <span>{saveState === 'dirty' ? 'Alterações pendentes' : saveState === 'saving' ? 'Salvando…' : saveState === 'saved' ? 'Salvo' : saveState === 'error' ? 'Falha ao salvar' : 'Salvo automaticamente'}</span>
        </div>
      </header>
      <div className="editor-toolbar" role="toolbar" aria-label="Formatação da nota">
        <button type="button" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} aria-label="Desfazer"><Undo2 size={16} /></button>
        <button type="button" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} aria-label="Refazer"><Redo2 size={16} /></button>
        <span className="toolbar-divider" />
        {toolbar.map((item) => {
          const Icon = item.icon;
          return <button type="button" key={item.label} onClick={item.action} className={item.active ? 'is-active' : ''} aria-label={item.label} aria-pressed={item.active}><Icon size={16} /></button>;
        })}
        <span className="toolbar-divider" />
        <button type="button" onClick={() => editor.chain().focus().insertContent('<span data-wikilink="Conceito">[[Conceito]]</span>').run()} aria-label="Inserir conexão"><Braces size={16} /><span>Conectar</span></button>
      </div>
      <EditorContent editor={editor} />
      {note.generatedContentMarkdown && <section className="note-generated" aria-label="Conteúdo gerado pelo Atlas">
        <header><Sparkles size={14} /><strong>Contexto gerado pelo Atlas</strong><span>somente leitura</span></header>
        <div className="note-prose" dangerouslySetInnerHTML={{ __html: markdownToHtml(note.generatedContentMarkdown) }} />
      </section>}
      <footer className="note-editor__footer"><span>Markdown</span><span>Digite <kbd>[[</kbd> para criar uma conexão</span><span><kbd>Ctrl</kbd> + <kbd>S</kbd> salvar</span></footer>
    </article>
  );
}
