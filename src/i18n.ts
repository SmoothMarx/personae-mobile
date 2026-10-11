/**
 * Single string table for the whole app.
 *
 * Language decision (2026-10-11): PT-PT. the user's standing product rule is that the interface is
 * written in the end user's language, in plain language, for a non-technical user. The end user of
 * this build is the user himself. Every user-visible string lives here so the choice is reversible by
 * editing one file — see QUESTIONS.md Q4.
 */

export const t = {
  appName: 'Personae',
  loading: 'A carregar…',
  retry: 'Tentar de novo',

  roster: {
    title: 'Personae',
    profiles: 'Perfis',
    primary: 'Principal',
    allProfiles: 'Tudo',
    sessions: 'Sessões',
    sessionsOf: (name: string) => `Sessões · ${name}`,
    emptyTitle: 'Ainda não há sessões',
    emptyBody: 'Quando este perfil tiver sessões, elas aparecem aqui.',
    newSession: 'Nova sessão',
    newSessionTitle: 'Nova sessão',
    newSessionPlaceholder: 'Título da sessão (opcional)',
    create: 'Criar',
    cancel: 'Cancelar',
    open: 'Abrir',
    openSettings: 'Definições',
    notConfiguredTitle: 'Falta configurar',
    notConfiguredBody: 'Indica o endereço do gateway e a chave de API em Definições para começar.',
    page: (cur: number, total: number, from: number, to: number, all: number) =>
      `Página ${cur} de ${total} · ${from}–${to} de ${all}`,
    prev: 'Anterior',
    next: 'Seguinte',
    newBadge: (n: number) => (n > 0 ? `${n} nova${n === 1 ? '' : 's'}` : ''),
    newTag: 'nova',
    messages: (n: number) => `${n} mensage${n === 1 ? 'm' : 'ns'}`,

    // ── the roster proper (0.5.0): a vertical list of faces that expand in place ──
    searchPlaceholder: 'Procurar perfis e conversas…',
    searchClear: 'Limpar',
    searchResults: (n: number) => (n === 1 ? '1 resultado' : `${n} resultados`),
    searchEmpty: 'Nada encontrado. Tenta outra palavra.',
    searchBodyHint: 'Inclui o texto das mensagens.',
    expandAll: 'Abrir todos',
    collapseAll: 'Fechar todos',
    automatic: 'Automático',
    automaticCount: (n: number) => (n === 1 ? '1 execução automática' : `${n} execuções automáticas`),
    automaticHelp:
      'Execuções de tarefas agendadas. Não são conversas; ficam aqui só para poderes vê-las.',
    noSessions: 'Sem conversas neste perfil.',
    profileErrorTitle: 'Não foi possível ler a lista de perfis',
    profileErrorBody:
      'O servidor respondeu, mas não deu a lista de perfis. Isto não é o mesmo que "não há perfis" — vê o erro abaixo e o registo de diagnóstico.',
    surfaceNoProfiles:
      'Esta ligação é a API do gateway (:9222), que não tem lista de perfis. Para ver o conjunto de perfis, muda em Definições para Dashboard (:9119).',

    groups: {
      title: 'Grupos',
      ungrouped: 'Sem grupo',
      new: 'Novo grupo',
      namePlaceholder: 'Nome do grupo',
      create: 'Criar grupo',
      rename: 'Mudar o nome',
      renamePrompt: 'Nome do grupo',
      delete: 'Apagar grupo',
      deleteConfirm: (name: string) =>
        `Apagar o grupo "${name}"? As conversas não são tocadas: os perfis voltam para «Sem grupo».`,
      empty: 'Grupo vazio. Mantém premido um perfil e escolhe «Mover para grupo» para o pôr aqui.',
      assign: 'Mover para grupo',
      assignment: (name: string) => `Mover para «${name}»`,
      remove: 'Tirar do grupo',
      help: 'Agrupa perfis com um nome. Apagar um grupo nunca apaga conversas.',
    },

    menu: {
      title: 'Ações',
      newSession: 'Nova sessão',
      rename: 'Mudar o nome…',
      renamePrompt: 'Novo nome',
      colour: 'Cor',
      colourNone: 'Sem cor',
      hide: 'Esconder perfil',
      unhide: 'Mostrar perfil',
      archiveAll: 'Arquivar todas as conversas',
      archiveAllConfirm: (label: string) =>
        `Arquivar todas as conversas de ${label}? Nada é apagado — ficam arquivadas no servidor.`,
      open: 'Abrir',
      copyId: 'Copiar identificador',
      copied: 'Identificador copiado.',
      sessionColour: 'Cor da conversa',
      deleteSession: 'Apagar conversa',
      deleteSessionConfirm: (title: string) => `Apagar a conversa "${title}"? Isto não se desfaz.`,
      deleted: 'Conversa apagada.',
      group: 'Grupo',
      sort: 'Ordenar',
      sortActivity: 'Por atividade',
      sortName: 'Por nome',
      sortSessions: 'Por nº de conversas',
      cancel: 'Cancelar',
    },

    lights: {
      waiting: 'À espera de ti',
      unread: 'Por ler',
      idle: 'Nada pendente',
      fresh: (n: number) => (n === 1 ? '1 nova desde a última visita' : `${n} novas desde a última visita`),
    },
  },

  thread: {
    you: 'Tu',
    agent: 'Agente',
    tools: (n: number) => `${n} chamada${n === 1 ? '' : 's'} a ferramentas`,
    showTools: 'Ver detalhes',
    hideTools: 'Esconder detalhes',
    reasoning: 'Pensamento',
    toolArgs: 'Argumentos',
    toolResult: 'Resultado',
    toolNoResult: 'sem resultado',
    toolFailed: 'falhou',
    orphanTool: 'resultado sem chamada correspondente',
    liveActivity: 'Atividade em direto',
    liveToolDone: 'concluída',
    liveToolRunning: 'a correr…',
    composerPlaceholder: 'Escreve uma mensagem…',
    send: 'Enviar',
    stop: 'Parar',
    thinking: 'A pensar…',
    historical: 'histórico',
    streamed: 'em direto',
    emptyThread: 'Sem mensagens nesta sessão. Escreve a primeira.',
    stopped: 'Resposta parada. O texto recebido ficou guardado.',
    fellBack: 'O modo em direto falhou; a resposta foi pedida novamente em bloco.',
  },

  settings: {
    title: 'Definições',
    surface: 'Tipo de ligação',
    surfaceHelp:
      'O dashboard (9119) usa uma credencial da app; a API do gateway (9222) usa a chave de API. É a app que fala com um deles de cada vez.',
    baseUrl: 'Endereço do servidor',
    baseUrlHelp: 'Ex.: http://10.0.0.5:9119',
    baseUrlHelpGateway: 'Ex.: http://10.0.0.5:9222',
    profilesFound: 'perfis encontrados',
    logTitle: 'Registo de diagnóstico',
    logHelp:
      'Um ficheiro .txt com o que a app tentou e falhou. Nada é enviado para fora: só é partilhado quando carregas no botão.',
    logPlaceholder: 'Escreve aqui o que se passou (opcional)…',
    logExport: 'Partilhar registo',
    logClear: 'Limpar',
    logShared: 'Registo criado e enviado para a partilha.',
    logCleared: 'Registo limpo.',
    logFailed: 'Não foi possível partilhar o registo.',
    apiKey: 'Chave de API',
    apiKeyHelp: 'Fica guardada no armazenamento seguro do telefone. Nunca sai daqui.',
    apiKeySet: 'guardada',
    apiKeyUnset: 'não definida',
    profiles: 'Perfis extra (prefixo)',
    profilesHelp: 'Um nome por linha. Cada um é servido em /p/<perfil>/.',
    model: 'Modelo (opcional)',
    modelHelp: 'Vazio usa o modelo por omissão do gateway.',
    effective: 'Em uso agora',
    clear: 'Limpar',
    saved: 'Guardado',
    savedKey: 'Chave guardada',
    clearKey: 'Apagar chave',
    clearKeyConfirm: 'Apagar a chave de API guardada neste telefone?',
    testConnection: 'Testar ligação',
    testing: 'A testar…',
    testOk: (v: string) => `Ligação OK · versão ${v}`,
    testFail: 'Falhou',
    autoSave: 'Cada campo é guardado sozinho.',
    showKey: 'Mostrar',
    hideKey: 'Esconder',
    valueSet: 'definido',
    valueUnset: 'vazio',
  },

  routes: {
    title: 'Rotas',
    help:
      'O mesmo gateway pode ser alcançado por vários caminhos. A app testa-os por ordem e usa o primeiro que responder.',
    empty: 'Ainda não há rotas. Escreve uma abaixo.',
    add: 'Adicionar rota',
    placeholder: 'http://10.0.0.5:9222',
    roleLan: 'Rede local',
    roleTailscale: 'Tailscale',
    rolePublic: 'Internet (público)',
    customRole: (role: string) => `Personalizado (${role})`,
    inferred: 'Deduzido do endereço',
    invalid: 'Endereço inválido',
    problemBadUrl: 'Endereço inválido — tem de começar por http:// ou https://',
    problemPublicHttp:
      'Um endereço público tem de ser https://. Este não será usado enquanto for http://.',
    problemNeedsAck:
      'Rota http:// numa rede privada: não tem TLS de aplicação. Autoriza em baixo para a usar.',
    moveUp: 'Subir',
    moveDown: 'Descer',
    remove: 'Remover',
    removeConfirm: (url: string) => `Remover a rota ${url}?`,
    priorityLabel: (n: number) => `prioridade ${n}`,
    ackTitle: 'Autorizar rotas http:// fora do loopback',
    ackHelp:
      'Rota privada sem TLS de aplicação. O tráfego continua cifrado pelo WireGuard do Tailscale quando o endereço é do tailnet.',
    preferredTitle: 'Rota preferida',
    preferredAuto: 'Automático',
    preferredHelp: 'Automático escolhe sempre pela ordem de prioridade.',
    secTailscaleTls: 'TLS de aplicação (certificado .ts.net)',
    secTailscaleWireguard:
      'Sem TLS de aplicação — cifrado pelo WireGuard do Tailscale',
    secLocalTls: 'TLS de aplicação',
    secLocalPlain: 'Sem TLS — rede local privada',
    secPublicTls: 'TLS de aplicação',
    secPublicPlain: 'Sem TLS — endereço público (só https:// é aceite)',
  },

  connectivity: {
    title: 'Ligação',
    tailscaleInstalled: 'Tailscale instalado',
    autoConnect: 'Ligar o túnel automaticamente ao abrir',
    autoConnectHelp:
      'Envia o pedido de ligação à app Tailscale ao abrir e ao voltar a primeiro plano.',
    tailscalePackage: 'Pacote do Tailscale',
    tailscalePackageHelp: 'Só é preciso mudar se usares uma versão modificada da app.',
    connectDeadline: 'Espera máxima (s)',
    probeTimeout: 'Tempo por tentativa (s)',
    openOnFailure: 'Abrir a Tailscale quando a ligação falhar',
    diagnosticsTitle: 'Estado da ligação',
    diagInstalled: 'Tailscale instalado',
    diagTunnel: 'Túnel',
    diagRoute: 'Rota escolhida',
    diagGateway: 'Gateway a responder',
    diagEverWorked: 'Já alguma vez ligou',
    diagLastError: 'Último erro',
    diagPinBypassed: (role: string) =>
      `A rota preferida (${role}) não respondeu; foi usada outra.`,
    yes: 'Sim',
    no: 'Não',
    unknown: 'Por saber',
    tunnelUp: 'Ligado',
    tunnelDown: 'Desligado',
    tunnelProbing: 'A ligar…',
    noneChosen: 'Nenhuma',
    diagTrigger: 'Último pedido ao túnel',
    diagVpnHint: 'A rede ativa tem VPN — indício, não prova',
    diagHealthCaveat:
      'O /v1/health a responder prova que a rota chega ao gateway; não prova que uma conversa vai funcionar.',
    diagNotAvailable: 'Só no Android',
    recheck: 'Verificar agora',
    setupIncomplete:
      'O túnel não ficou pronto dentro do tempo. Abre a Tailscale, liga-a, e volta aqui.',
    openTailscale: 'Abrir Tailscale',
    notInstalled:
      'A app Tailscale não está instalada neste telefone. Instala-a ou usa uma rota de rede local.',
    permanentKey:
      'A chave de API foi recusada. Corrige a chave em Definições — não vale a pena tentar de novo.',
    iosNote:
      'No iPhone não é possível ligar a Tailscale a partir daqui: não existe este mecanismo entre apps. Liga o "On-Demand" nas Definições da Tailscale e a app liga-se sozinha a seguir.',
  },

  errors: {
    noBaseUrl: 'Falta o endereço do gateway. Abre Definições e escreve-o.',
    badBaseUrl: (v: string) => `O endereço "${v}" não é válido. Tem de começar por http:// ou https://`,
    noKey: 'Falta a chave de API. Abre Definições e escreve-a.',
    unauthorized:
      'A chave de API foi recusada pelo gateway (401). Confirma a chave em Definições.',
    unauthorizedProfile: (p: string) =>
      `A chave de API foi recusada pelo gateway (401) para o perfil "${p}". Confirma a chave e o nome do perfil.`,
    network: (detail: string) =>
      `Não foi possível contactar o gateway. Verifica o endereço e se estás na mesma rede. (${detail})`,
    timeout: (sec: number) => `O gateway não respondeu em ${sec} s.`,
    notFound: (what: string) => `${what} não existe no gateway (404).`,
    sessionGone: 'Esta sessão já não existe no gateway.',
    server: (status: number, detail: string) => `Erro no gateway (${status}): ${detail}`,
    badJson: 'A resposta do gateway não é JSON válido.',
    badStream: 'A transmissão em direto veio em formato inválido.',
    missingMessage: "Falta o campo 'message'.",
    streamDropped: 'A transmissão em direto caiu antes do fim.',
  },

  status: {
    ok: 'A responder',
    degraded: 'Instável',
    down: 'Sem resposta',
    unknown: 'Por testar',
    auth: 'Chave recusada',
  },

  /**
   * Accessibility labels, PT-PT (F2): every icon-only control needs one, or it is unusable with a
   * screen reader. Kept apart from the visible copy so a label can be longer than a caption.
   */
  a11y: {
    avatar: (name: string) => `Fotografia de perfil de ${name}`,
    contact: (label: string, hasAvatar: boolean) =>
      `Perfil ${label}${hasAvatar ? ', com fotografia' : ''}`,
    send: 'Enviar mensagem',
    stop: 'Parar a resposta',
    refresh: 'Atualizar a lista',
    settings: 'Abrir definições',
    newSession: 'Criar uma sessão nova',
    expandDetails: 'Ver os detalhes desta chamada',
    collapseDetails: 'Esconder os detalhes desta chamada',
    expandReasoning: 'Ver o pensamento do agente',
    collapseReasoning: 'Esconder o pensamento do agente',
    pagePrev: 'Página anterior',
    pageNext: 'Página seguinte',
    toolFailed: 'a chamada falhou',
    surface: (label: string) => `Tipo de ligação: ${label}`,
    exportLog: 'Exportar o registo de diagnóstico',
  },

  common: {
    back: 'Voltar',
    close: 'Fechar',
    unknown: '—',
    yes: 'Sim',
    no: 'Não',
  },
} as const;

export type Strings = typeof t;
