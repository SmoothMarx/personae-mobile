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
  },

  thread: {
    you: 'Tu',
    agent: 'Agente',
    tools: (n: number) => `${n} chamada${n === 1 ? '' : 's'} a ferramentas`,
    showTools: 'Ver detalhes',
    hideTools: 'Esconder detalhes',
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
    baseUrl: 'Endereço do gateway',
    baseUrlHelp: 'Ex.: http://100.64.0.5:8642',
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

  common: {
    back: 'Voltar',
    close: 'Fechar',
    unknown: '—',
    yes: 'Sim',
    no: 'Não',
  },
} as const;

export type Strings = typeof t;
