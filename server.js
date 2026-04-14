const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(cors());

const pastaFront = path.join(__dirname, '..', 'eleicoes-front'); 
app.use(express.static(pastaFront));

app.get('/', (req, res) => {
    res.sendFile(path.join(pastaFront, 'index.html'));
});

// API APURAÇÃO (DINÂMICA: PRESIDENTE, GOVERNADOR, ETC)
app.get('/api/apuracao', async (req, res) => {
    const { turno = '1', cargo = '1', uf = 'br' } = req.query;

    // 1. Bloqueia se tentar buscar cargos regionais para o Brasil inteiro
    if (cargo !== '1' && uf.toLowerCase() === 'br') {
        return res.json({
            erro: true,
            mensagem: 'Selecione um Estado (UF) para ver os dados deste cargo.'
        });
    }

    // 2. Define o código da Eleição (Baseado no TSE de 2022 para simulação)
    // Nota: Para as eleições de 2026, estes códigos (544, 545, etc.) vão mudar!
    let eleicao = '544';
    if (cargo === '1') {
        // Presidente: 1º Turno = 544 | 2º Turno = 545
        eleicao = (turno === '2') ? '545' : '544'; 
    } else {
        // Governador, Senador, etc: 1º Turno = 546 | 2º Turno = 547
        eleicao = (turno === '2') ? '547' : '546'; 
    }

    // 3. Formata o cargo e a UF (TSE exige 4 dígitos e letras minúsculas)
    const cargoFormatado = String(cargo).padStart(4, '0');
    const ufFormatada = uf.toLowerCase();

    // 4. Monta a URL exata do arquivo JSON
    const url = `https://resultados.tse.jus.br/oficial/ele2022/${eleicao}/dados-simplificados/${ufFormatada}/${ufFormatada}-c${cargoFormatado}-e000${eleicao}-r.json`;

    try {
        const response = await fetch(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json'
            }
        });

        // 5. TRATAMENTO INTELIGENTE DE ERROS DA API
        // O TSE retorna 404 se o arquivo não existe (ex: estado não teve 2º turno)
        if (response.status === 404) {
            return res.json({ 
                erro: true, 
                mensagem: turno === '2' 
                    ? 'Não houve 2º turno para este cargo neste estado.' 
                    : 'Dados não encontrados no TSE para esta consulta.' 
            });
        }

        // Se der outro erro (ex: 500, 403), cai no catch
        if (!response.ok) {
            throw new Error(`Erro na API do TSE: Status ${response.status}`);
        }

const data = await response.json();

        if (!data.cand || data.cand.length === 0) {
            return res.json({ erro: true, mensagem: 'Nenhum candidato encontrado para este cargo/turno.' });
        }

        // 1. Mapeia TODOS os candidatos primeiro e converte os votos para número inteiro
        let todosCandidatos = data.cand.map(c => ({
            sqcand: c.sqcand,
            nome: c.nm,
            partido: c.cc,
            votos: c.pvap.replace(',', '.'), // Porcentagem
            votosNumero: parseInt(c.vap) || 0, // Usamos isso estritamente para a matemática
            total: parseInt(c.vap).toLocaleString('pt-BR'), // Texto formatado para o Front
            eleito: c.e === 's' || c.e === 'S',
            segundoTurno: c.e === '2t' || c.e === '2T',
            foto: `https://resultados.tse.jus.br/oficial/ele2022/${eleicao}/fotos/${ufFormatada}/${c.sqcand}.jpeg`
        }));

        // 2. ORDENA DO MAIOR PARA O MENOR (usando a quantidade absoluta de votos)
        todosCandidatos.sort((a, b) => b.votosNumero - a.votosNumero);

        // 3. Retorna TODOS os candidatos (Sem o .slice)
        res.json({
            turno, 
            percurso: data.pst || "0,00",
            atualizacao: data.dg && data.hg ? `${data.dg} às ${data.hg}` : 'Sem dados de hora',
            // Adicionamos esta nova seção lendo as siglas oficiais do TSE:
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
        });

    } catch (e) {
        console.error('Erro real de conexão:', e.message);
        res.status(500).json({ 
            erro: true, 
            mensagem: 'Servidor do TSE indisponível ou erro interno.' 
        });
    }
});

app.listen(3000, () => {
    console.log("-----------------------------------------");
    console.log("🚀 SERVIDOR RODANDO COM SUCESSO!");
    console.log("👉 http://localhost:3000");
    console.log("-----------------------------------------");
});