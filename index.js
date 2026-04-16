const express = require('express');
const cors = require('cors');
const path = require('path');
const compression = require('compression');

const app = express();

app.use(cors());
app.use(compression());

// =====================
// 📦 CACHE EM MEMÓRIA
// =====================
const cache = {};
const cacheTempo = {};
const CACHE_TTL = 30000; // 30 segundos

// =====================
// 📁 FRONT (opcional)
// =====================
const pastaFront = path.join(__dirname, '..', 'eleicoes-front');
app.use(express.static(pastaFront));

app.get('/', (req, res) => {
    res.sendFile(path.join(pastaFront, 'index.html'));
});

// =====================
// 🔌 API APURAÇÃO
// =====================
app.get('/api/apuracao', async (req, res) => {
    const { turno = '1', cargo = '1', uf = 'br' } = req.query;

    const cacheKey = `${turno}-${cargo}-${uf}`;

    // 🔥 CACHE (antes de tudo)
    if (cache[cacheKey] && (Date.now() - cacheTempo[cacheKey]) < CACHE_TTL) {
        return res.json(cache[cacheKey]);
    }

    // 1. Validação
    if (cargo !== '1' && uf.toLowerCase() === 'br') {
        return res.json({
            erro: true,
            mensagem: 'Selecione um Estado (UF) para ver os dados deste cargo.'
        });
    }

    // 2. Código da eleição
    let eleicao = '544';
    if (cargo === '1') {
        eleicao = (turno === '2') ? '545' : '544';
    } else {
        eleicao = (turno === '2') ? '547' : '546';
    }

    const cargoFormatado = String(cargo).padStart(4, '0');
    const ufFormatada = uf.toLowerCase();

    const url = `https://resultados.tse.jus.br/oficial/ele2022/${eleicao}/dados-simplificados/${ufFormatada}/${ufFormatada}-c${cargoFormatado}-e000${eleicao}-r.json`;

    try {
        // ⏱️ TIMEOUT (5s)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json'
            },
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (response.status === 404) {
            return res.json({
                erro: true,
                mensagem: turno === '2'
                    ? 'Não houve 2º turno para este cargo neste estado.'
                    : 'Dados não encontrados no TSE para esta consulta.'
            });
        }

        if (!response.ok) {
            throw new Error(`Erro na API do TSE: Status ${response.status}`);
        }

        const data = await response.json();

        if (!data.cand || data.cand.length === 0) {
            return res.json({
                erro: true,
                mensagem: 'Nenhum candidato encontrado para este cargo/turno.'
            });
        }

        let todosCandidatos = data.cand.map(c => ({
            sqcand: c.sqcand,
            nome: c.nm,
            partido: c.cc,
            votos: c.pvap.replace(',', '.'),
            votosNumero: parseInt(c.vap) || 0,
            total: parseInt(c.vap).toLocaleString('pt-BR'),
            eleito: c.e === 's' || c.e === 'S',
            segundoTurno: c.e === '2t' || c.e === '2T',
            foto: `https://resultados.tse.jus.br/oficial/ele2022/${eleicao}/fotos/${ufFormatada}/${c.sqcand}.jpeg`
        }));

        todosCandidatos.sort((a, b) => b.votosNumero - a.votosNumero);

        const respostaFinal = {
            turno,
            percurso: data.pst || "0,00",
            atualizacao: data.dg && data.hg
                ? `${data.dg} às ${data.hg}`
                : 'Sem dados de hora',
            resumo: {
                validos: data.vv ? parseInt(data.vv).toLocaleString('pt-BR') : '--',
                pctValidos: data.pvv || '0,00',
                brancos: data.vb ? parseInt(data.vb).toLocaleString('pt-BR') : '--',
                pctBrancos: data.pvb || '0,00',
                nulos: data.tvn ? parseInt(data.tvn).toLocaleString('pt-BR') : '--',
                pctNulos: data.ptvn || '0,00',
                abstencoes: data.a ? parseInt(data.a).toLocaleString('pt-BR') : '--',
                pctAbstencoes: data.pa || '0,00'
            },
            candidatos: todosCandidatos
        };

        // 🔥 salva no cache
        cache[cacheKey] = respostaFinal;
        cacheTempo[cacheKey] = Date.now();

        res.json(respostaFinal);

    } catch (e) {
        console.error('Erro real de conexão:', e.message);

        res.status(500).json({
            erro: true,
            mensagem: 'Servidor do TSE indisponível ou erro interno.'
        });
    }
});

// =====================
// 🚀 START
// =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("-----------------------------------------");
    console.log("🚀 SERVIDOR RODANDO!");
    console.log(`👉 Porta: ${PORT}`);
    console.log("-----------------------------------------");
});