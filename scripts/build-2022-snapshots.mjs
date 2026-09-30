import { createReadStream, createWriteStream, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';

const VALID_OFFICES = new Set(['1', '3', '5', '6', '7', '8']);
const ELECTION_CODES = Object.freeze({
	'1:1': '544',
	'2:1': '545',
	'1:estadual': '546',
	'2:estadual': '547',
});
const ELECTION_DATES = Object.freeze({ '1': '02/10/2022', '2': '30/10/2022' });

const [nominalArg, detailArg, outputArg] = process.argv.slice(2);
if (!nominalArg || !detailArg || !outputArg) {
	throw new Error('Uso: node scripts/build-2022-snapshots.mjs <diretorio-nominal> <diretorio-detalhe> <arquivo-saida>');
}

const nominalDirectory = resolve(nominalArg);
const detailDirectory = resolve(detailArg);
const outputFile = resolve(outputArg);
const candidatesByResult = new Map();
const totalsByResult = new Map();

for (const file of listCsvFiles(nominalDirectory)) {
	await processCsv(file, (row) => aggregateCandidate(row, file));
	process.stdout.write(`Candidatos processados: ${basename(file)}\n`);
}

for (const file of listCsvFiles(detailDirectory)) {
	await processCsv(file, (row) => aggregateTotals(row, file));
	process.stdout.write(`Totais processados: ${basename(file)}\n`);
}

const snapshots = buildSnapshots();
await writeBulkFile(outputFile, snapshots);

const candidatesCount = snapshots.reduce((total, item) => total + item.payload.candidatos.length, 0);
process.stdout.write(`Snapshots gerados: ${snapshots.length}\n`);
process.stdout.write(`Candidatos nos snapshots: ${candidatesCount}\n`);
process.stdout.write(`Arquivo KV: ${outputFile}\n`);

function listCsvFiles(directory) {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
		.map((entry) => resolve(directory, entry.name))
		.sort();
}

async function processCsv(file, consume) {
	const lines = createInterface({
		input: createWindows1252ReadStream(file),
		crlfDelay: Infinity,
	});
	let columns;

	for await (const line of lines) {
		if (!columns) {
			columns = splitCsvLine(line).map(cleanField);
			continue;
		}
		if (!line) {
			continue;
		}

		const fields = splitCsvLine(line);
		const row = {};
		for (let index = 0; index < columns.length; index += 1) {
			row[columns[index]] = cleanField(fields[index]);
		}
		consume(row);
	}
}

function createWindows1252ReadStream(file) {
	const decoder = new TextDecoder('windows-1252');
	return createReadStream(file, { highWaterMark: 1024 * 1024 }).pipe(
		new Transform({
			transform(chunk, _encoding, callback) {
				callback(null, decoder.decode(chunk, { stream: true }));
			},
			flush(callback) {
				const remainder = decoder.decode();
				if (remainder) {
					this.push(remainder);
				}
				callback();
			},
		}),
	);
}

function splitCsvLine(line) {
	const fields = [];
	let value = '';
	let quoted = false;

	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		if (character === '"') {
			if (quoted && line[index + 1] === '"') {
				value += '"';
				index += 1;
			} else {
				quoted = !quoted;
			}
		} else if (character === ';' && !quoted) {
			fields.push(value);
			value = '';
		} else {
			value += character;
		}
	}
	fields.push(value);
	return fields;
}

function cleanField(value) {
	return String(value ?? '').replace(/^\uFEFF/, '').trim();
}

function scopeFromFile(file) {
	const match = basename(file).match(/_([A-Z]{2})\.csv$/i);
	if (!match) {
		throw new Error(`Nao foi possivel identificar a abrangencia de ${file}`);
	}
	return match[1].toLowerCase();
}

function resultKey(round, office, scope) {
	return `${round}:${office}:${scope}`;
}

function aggregateCandidate(row, file) {
	const round = row.NR_TURNO;
	const office = row.CD_CARGO;
	if (row.ANO_ELEICAO !== '2022' || row.CD_TIPO_ELEICAO !== '2' || !VALID_OFFICES.has(office)) {
		return;
	}
	if (round === '2' && !['1', '3'].includes(office)) {
		return;
	}

	const fileScope = scopeFromFile(file);
	const scope = office === '1' ? 'br' : fileScope;
	if ((office === '1' && fileScope !== 'br') || (office !== '1' && fileScope === 'br')) {
		return;
	}

	const key = resultKey(round, office, scope);
	let candidates = candidatesByResult.get(key);
	if (!candidates) {
		candidates = new Map();
		candidatesByResult.set(key, candidates);
	}

	const sequence = row.SQ_CANDIDATO;
	let candidate = candidates.get(sequence);
	if (!candidate) {
		candidate = {
			nome: normalizeNull(row.NM_URNA_CANDIDATO) || normalizeNull(row.NM_CANDIDATO) || '',
			nomeCompleto: normalizeNull(row.NM_CANDIDATO) || normalizeNull(row.NM_URNA_CANDIDATO) || '',
			numero: normalizeNull(row.NR_CANDIDATO),
			partido: normalizeNull(row.SG_PARTIDO) || '',
			nomePartido: normalizeNull(row.NM_PARTIDO) || '',
			composicao: normalizeNull(row.DS_COMPOSICAO_COLIGACAO) || normalizeNull(row.NM_COLIGACAO) || '',
			votosNumero: 0,
			eleito: isElected(row.DS_SIT_TOT_TURNO),
			situacao: normalizeNull(row.DS_SIT_TOT_TURNO),
			destinacaoVoto: normalizeNull(row.NM_TIPO_DESTINACAO_VOTOS),
			foto: null,
			viceSuplentes: [],
		};
		candidates.set(sequence, candidate);
	}

	candidate.votosNumero += toInteger(row.QT_VOTOS_NOMINAIS);
}

function aggregateTotals(row, file) {
	const round = row.NR_TURNO;
	const office = row.CD_CARGO;
	if (row.ANO_ELEICAO !== '2022' || row.CD_TIPO_ELEICAO !== '2' || !VALID_OFFICES.has(office)) {
		return;
	}
	if (round === '2' && !['1', '3'].includes(office)) {
		return;
	}

	const fileScope = scopeFromFile(file);
	const scope = office === '1' ? 'br' : fileScope;
	if ((office === '1' && fileScope !== 'br') || (office !== '1' && fileScope === 'br')) {
		return;
	}

	const key = resultKey(round, office, scope);
	let totals = totalsByResult.get(key);
	if (!totals) {
		totals = {
			aptos: 0,
			secoes: 0,
			comparecimento: 0,
			abstencoes: 0,
			votos: 0,
			validos: 0,
			brancos: 0,
			nulos: 0,
			updatedAt: null,
		};
		totalsByResult.set(key, totals);
	}

	totals.aptos += toInteger(row.QT_APTOS);
	totals.secoes += toInteger(row.QT_TOTAL_SECOES);
	totals.comparecimento += toInteger(row.QT_COMPARECIMENTO);
	totals.abstencoes += toInteger(row.QT_ABSTENCOES);
	totals.votos += toInteger(row.QT_VOTOS);
	totals.validos += toInteger(row.QT_TOTAL_VOTOS_VALIDOS);
	totals.brancos += toInteger(row.QT_VOTOS_BRANCOS);
	totals.nulos += toInteger(row.QT_TOTAL_VOTOS_NULOS);
	totals.updatedAt = latestUpdate(totals.updatedAt, row.DT_ULTIMA_TOTALIZACAO, row.HH_ULTIMA_TOTALIZACAO);
}

function buildSnapshots() {
	const snapshots = [];

	for (const [key, candidateMap] of [...candidatesByResult.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const totals = totalsByResult.get(key);
		if (!totals) {
			throw new Error(`Totais nao encontrados para ${key}`);
		}

		const [round, office, scope] = key.split(':');
		const candidates = [...candidateMap.values()].sort((left, right) => right.votosNumero - left.votosNumero);
		for (const candidate of candidates) {
			candidate.votos = percentage(candidate.votosNumero, totals.validos, '.');
			candidate.total = formatInteger(candidate.votosNumero);
		}

		const electionCode = office === '1' ? ELECTION_CODES[`${round}:1`] : ELECTION_CODES[`${round}:estadual`];
		const payload = {
			ano: 2022,
			turno: Number(round),
			cargo: Number(office),
			uf: scope,
			fonte: 'Tribunal Superior Eleitoral - Portal de Dados Abertos',
			fase: 'oficial',
			finalizado: true,
			andamento: 'f',
			idGeracao: `historico-2022-${round}-${office}-${scope}`,
			eleicao: {
				codigo: electionCode,
				nome: 'Eleições Gerais 2022',
				data: ELECTION_DATES[round],
				ciclo: 'ele2022',
			},
			percurso: '100,00',
			atualizacao: totals.updatedAt?.formatted || null,
			vagas: ['1', '3', '5'].includes(office) ? 1 : candidates.filter((candidate) => candidate.eleito).length || null,
			resumo: {
				validos: formatInteger(totals.validos),
				pctValidos: percentage(totals.validos, totals.votos, ','),
				brancos: formatInteger(totals.brancos),
				pctBrancos: percentage(totals.brancos, totals.votos, ','),
				nulos: formatInteger(totals.nulos),
				pctNulos: percentage(totals.nulos, totals.votos, ','),
				abstencoes: formatInteger(totals.abstencoes),
				pctAbstencoes: percentage(totals.abstencoes, totals.aptos, ','),
			},
			totalCandidatos: candidates.length,
			candidatos: candidates,
			arquivoHistorico: {
				armazenadoLocalmente: true,
				fonte: 'https://dadosabertos.tse.jus.br/dataset/resultados-2022',
			},
		};

		snapshots.push({
			key: `eleicoes:historico:2022:${round}:${office}:${scope}`,
			payload,
		});
	}

	return snapshots;
}

async function writeBulkFile(file, snapshots) {
	const output = createWriteStream(file, { encoding: 'utf8' });
	output.write('[\n');

	for (let index = 0; index < snapshots.length; index += 1) {
		const snapshot = snapshots[index];
		const entry = {
			key: snapshot.key,
			value: JSON.stringify(snapshot.payload),
			metadata: {
				ano: 2022,
				geradoEm: new Date().toISOString(),
				fonte: 'TSE Dados Abertos',
			},
		};
		output.write(`${index === 0 ? '' : ',\n'}${JSON.stringify(entry)}`);
	}

	output.end('\n]\n');
	await new Promise((resolvePromise, rejectPromise) => {
		output.on('finish', resolvePromise);
		output.on('error', rejectPromise);
	});
}

function normalizeNull(value) {
	const normalized = String(value ?? '').trim();
	return normalized === '#NULO' || normalized === '#NULO#' || normalized === '#NE' || normalized === '-1' ? null : normalized;
}

function isElected(status) {
	return String(status || '').trim().toLocaleLowerCase('pt-BR').startsWith('eleito');
}

function toInteger(value) {
	const parsed = Number.parseInt(String(value || '0'), 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

function percentage(value, total, decimalSeparator) {
	const result = total ? ((value / total) * 100).toFixed(2) : '0.00';
	return decimalSeparator === ',' ? result.replace('.', ',') : result;
}

function formatInteger(value) {
	return Number(value || 0).toLocaleString('pt-BR');
}

function latestUpdate(current, date, time) {
	if (!date && !time) {
		return current;
	}
	const [day = '01', month = '01', year = '1970'] = String(date || '').split('/');
	const sortable = `${year}-${month}-${day}T${time || '00:00:00'}`;
	if (!current || sortable > current.sortable) {
		return { sortable, formatted: date && time ? `${date} às ${time}` : date || time };
	}
	return current;
}
