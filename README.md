# ⚡ PIX Recovery — Sistema de Recuperação de Pagamentos

Sistema para recuperar pagamentos PIX gerados e não pagos, com envio automático via WhatsApp usando Baileys.

---

## 🚀 Instalação

### Pré-requisitos
- Node.js 18 ou superior
- npm

### 1. Instale as dependências

```bash
npm install
```

### 2. Inicie o servidor

```bash
npm start
```

O painel estará disponível em: **http://localhost:3000**

---

## 📱 Configurar WhatsApp

1. Acesse o painel → **Conexão WhatsApp**
2. Clique em **Conectar WhatsApp**
3. Aguarde o QR Code aparecer
4. Abra o WhatsApp no celular → **Dispositivos vinculados** → **Vincular dispositivo**
5. Escaneie o QR Code
6. A sessão ficará salva em `data/wa_auth/`

> ✅ A partir deste momento, o sistema enviará mensagens automaticamente sem precisar escanear novamente.

---

## 🔗 Configurar Webhooks

### Kiwify
1. Acesse: Kiwify → Produtos → Integrações → Webhooks
2. Adicione o URL: `http://SEU_SERVIDOR:3000/webhook/kiwify`
3. Selecione o evento: **Pedido gerado**

### Hotmart
1. Acesse: Hotmart → Ferramentas → Webhooks
2. Adicione o URL: `http://SEU_SERVIDOR:3000/webhook/hotmart`
3. Selecione o evento: **PURCHASE_WAITING_PAYMENT**

### Para usar externamente (produção)
Use **ngrok** ou um VPS para expor a porta 3000:
```bash
npx ngrok http 3000
```

---

## ⚙️ Configurações

### Mensagem
Acesse o painel → **Configuração de Mensagem** para editar o texto enviado.

Variáveis disponíveis:
- `{nome}` — Nome do cliente
- `{link_pix}` — Link do PIX

### Agendamentos
Acesse o painel → **Agendamentos** para ativar/desativar os envios em:
- 15 minutos após geração
- 4 horas após geração
- 24 horas após geração

---

## 📂 Estrutura de Arquivos

```
pix-recovery/
├── server.js          # Servidor principal
├── package.json
├── public/
│   └── index.html     # Painel administrativo
└── data/              # Dados persistidos (criado automaticamente)
    ├── payments.json  # Registros de PIX
    ├── config.json    # Configurações
    ├── logs.json      # Logs do sistema
    └── wa_auth/       # Sessão do WhatsApp
```

---

## 🔄 Lógica de Funcionamento

```
Webhook recebe PIX gerado
        ↓
Sistema registra cliente
        ↓
Agendamentos criados (15min / 4h / 24h)
        ↓
Scheduler verifica a cada minuto
        ↓
Se pendente + tempo atingido → Envia WhatsApp
        ↓
Se cliente responder → Automação pausada
```

---

## 🧪 Testar o Sistema

Envie um POST para testar:

```bash
curl -X POST http://localhost:3000/webhook/test \
  -H "Content-Type: application/json" \
  -d '{
    "customer_name": "João Silva",
    "customer_phone": "5548999999999",
    "pix_link": "https://pix.example.com/abc123"
  }'
```

Ou use o botão **"Enviar PIX de Teste"** na tela de Webhooks do painel.

---

## 🔮 Expansão Futura

O sistema foi estruturado para suportar no futuro:
- Recuperação de boleto vencido
- Mensagens pós-compra (upsell/cross-sell)
- Integração com Eduzz, Braip, Monetizze
- Múltiplos números de WhatsApp
- Relatórios e exportação CSV
