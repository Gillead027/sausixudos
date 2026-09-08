import { useEffect, useState } from 'react';
import { CloseIcon, PlusIcon, SearchIcon, SettingsIcon, UserIcon } from './Icons';

type ServerSettingsSection = 'profile' | 'roles';

export function ServerSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [section, setSection] = useState<ServerSettingsSection>('profile');

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <section className="server-settings-shell" aria-label="Configurações do servidor">
      <nav className="server-settings-nav">
        <div className="server-settings-heading">
          <span className="server-settings-avatar">S</span>
          <div><strong>Lobby dos amigos</strong><span>Configurações do servidor</span></div>
        </div>
        <span className="settings-nav-group">Servidor</span>
        <button type="button" className={section === 'profile' ? 'active' : ''} onClick={() => setSection('profile')}>
          <SettingsIcon size={17} /> Perfil do servidor
        </button>
        <button type="button"><span className="nav-glyph">⌁</span> Visão geral</button>
        <button type="button"><span className="nav-glyph">✦</span> Impulsos</button>
        <span className="settings-nav-group">Pessoas</span>
        <button type="button" className={section === 'roles' ? 'active' : ''} onClick={() => setSection('roles')}>
          <UserIcon size={17} /> Cargos
        </button>
        <button type="button"><span className="nav-glyph">♙</span> Membros</button>
        <button type="button"><span className="nav-glyph">⌘</span> Convites</button>
        <span className="settings-nav-group">Moderação</span>
        <button type="button"><span className="nav-glyph">◇</span> Segurança</button>
        <button type="button"><span className="nav-glyph">▤</span> Registro de auditoria</button>
        <span className="settings-nav-group">Comunidade</span>
        <button type="button"><span className="nav-glyph">◉</span> Integrações</button>
        <button type="button"><span className="nav-glyph">▱</span> Widgets</button>
        <div className="server-settings-nav-spacer" />
        <button type="button" className="server-settings-danger"><span className="nav-glyph">⊘</span> Excluir servidor</button>
      </nav>

      <div className="server-settings-content">
        {section === 'profile' ? <ServerProfilePane /> : <RolesPane />}
      </div>
      <button type="button" className="server-settings-close" onClick={onClose} aria-label="Fechar configurações do servidor">
        <CloseIcon size={20} /><span>ESC</span>
      </button>
    </section>
  );
}

function ServerProfilePane() {
  return (
    <div className="server-profile-page">
      <div className="server-page-title">
        <div><h1>Perfil do servidor</h1><p>Personalize a aparência e a identidade do seu servidor.</p></div>
        <button type="button" className="secondary-pill">Pré-visualizar</button>
      </div>
      <div className="server-profile-columns">
        <div className="server-profile-form">
          <section className="server-settings-card server-banner-card">
            <span className="field-eyebrow">Banner do servidor</span>
            <div className="server-banner-preview">
              <div className="server-banner-art"><i /><i /><i /></div>
              <button type="button" className="banner-edit-button">✎</button>
            </div>
            <p>Recomendado: 1920 × 480. PNG, JPG ou WEBP.</p>
          </section>
          <section className="server-settings-card server-identity-card">
            <div className="server-icon-large">S<span>✎</span></div>
            <div className="server-name-fields">
              <label>Nome do servidor<input readOnly value="Lobby dos amigos" /></label>
              <label>Descrição<textarea readOnly rows={3} value="Um lugar para conversar, jogar e compartilhar bons momentos." /></label>
            </div>
          </section>
          <section className="server-settings-card">
            <label>Cor de destaque</label>
            <div className="static-swatches" aria-label="Cores de destaque">
              {['#7c6ff2', '#4fc6ad', '#ee7798', '#f2ad5c', '#4f8edc', '#a76de0', '#68708b'].map((color, index) => (
                <button key={color} type="button" className={index === 0 ? 'selected' : ''} style={{ background: color }} aria-label={`Cor ${index + 1}`} />
              ))}
            </div>
          </section>
          <div className="server-form-actions">
            <button type="button" className="secondary-pill">Descartar</button>
            <button type="button" className="violet-primary">Salvar alterações</button>
          </div>
        </div>
        <aside className="server-live-preview">
          <span className="field-eyebrow">Pré-visualização</span>
          <div className="server-preview-card">
            <div className="server-preview-banner"><i /><i /><i /></div>
            <div className="server-preview-body">
              <span className="server-icon-large">S</span>
              <h2>Lobby dos amigos</h2>
              <p>Um lugar para conversar, jogar e compartilhar bons momentos.</p>
              <div><span>● 5 online</span><span>9 membros</span></div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function RolesPane() {
  const permissionGroups = [
    ['Permissões gerais', ['Ver canais', 'Gerenciar canais', 'Gerenciar cargos']],
    ['Permissões de texto', ['Enviar mensagens', 'Gerenciar mensagens', 'Anexar arquivos']],
    ['Permissões de voz', ['Conectar', 'Falar', 'Transmitir vídeo']],
  ];
  return (
    <div className="roles-page">
      <div className="server-page-title">
        <div><h1>Cargos</h1><p>Use cargos para organizar os membros e controlar permissões.</p></div>
        <button type="button" className="violet-primary"><PlusIcon size={15} /> Criar cargo</button>
      </div>
      <div className="roles-workspace">
        <aside className="roles-list">
          <label className="roles-search"><SearchIcon size={14} /><input readOnly placeholder="Buscar cargos" /></label>
          <span className="field-eyebrow">Cargos — 4</span>
          {[
            ['Administrador', '#ee7798', '2'],
            ['Moderador', '#7c6ff2', '3'],
            ['Amigo', '#4fc6ad', '7'],
            ['@everyone', '#8a91a6', '9'],
          ].map(([name, color, count], index) => (
            <button type="button" key={name} className={index === 0 ? 'active' : ''}>
              <i style={{ background: color }} /><span><strong>{name}</strong><small>{count} membros</small></span><b>⋮</b>
            </button>
          ))}
        </aside>
        <section className="role-editor">
          <div className="role-editor-heading"><div><span className="role-color-dot" /><h2>Administrador</h2><small>2 membros</small></div><button type="button">•••</button></div>
          <div className="role-tabs"><button type="button" className="active">Exibição</button><button type="button">Permissões</button><button type="button">Gerenciar membros</button></div>
          <div className="role-fields-grid">
            <label>Nome do cargo<input readOnly value="Administrador" /></label>
            <label>Cor do cargo<div className="role-color-input"><i />#EE7798</div></label>
          </div>
          <div className="role-static-toggle"><div><strong>Exibir membros do cargo separadamente</strong><span>Mostra este cargo como um grupo próprio na lista de membros.</span></div><button type="button" className="static-switch on" /></div>
          <div className="role-static-toggle"><div><strong>Permitir que qualquer pessoa mencione este cargo</strong><span>Os membros poderão usar @Administrador nas mensagens.</span></div><button type="button" className="static-switch" /></div>
          <div className="permissions-heading"><div><h3>Permissões</h3><p>Defina o que os membros deste cargo podem fazer.</p></div><label className="roles-search"><SearchIcon size={14} /><input readOnly placeholder="Buscar permissões" /></label></div>
          {permissionGroups.map(([title, permissions]) => (
            <div className="permission-group" key={title as string}>
              <span className="field-eyebrow">{title as string}</span>
              {(permissions as string[]).map((permission, index) => (
                <div className="permission-row" key={permission}><span>{permission}</span><div><button type="button" className={index === 0 ? 'allow' : ''}>✓</button><button type="button" className={index === 1 ? 'deny' : ''}>×</button><button type="button" className={index > 1 ? 'neutral active' : 'neutral'}>／</button></div></div>
              ))}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
