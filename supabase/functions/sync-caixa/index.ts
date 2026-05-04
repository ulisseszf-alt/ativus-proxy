// supabase/functions/sync-caixa/index.ts
// Edge Function que busca CSV da Caixa e salva no banco
// Roda automaticamente via Cron todo dia às 3h

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ESTADOS = ['PR', 'SP', 'RJ', 'MG', 'SC', 'RS', 'BA', 'GO', 'DF', 'CE'];

Deno.serve(async (req) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      }
    });
  }

  const supabaseUrl  = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase     = createClient(supabaseUrl, supabaseKey);

  // Qual estado sincronizar (padrão: PR)
  const url    = new URL(req.url);
  const estado = url.searchParams.get('estado') || 'PR';
  const todos  = url.searchParams.get('todos') === 'true';

  const estadosSincronizar = todos ? ESTADOS : [estado.toUpperCase()];
  const resultados: Record<string, unknown> = {};

  for (const uf of estadosSincronizar) {
    try {
      console.log(`Buscando CSV da Caixa para ${uf}...`);
      
      const csvUrl = `https://venda-imoveis.caixa.gov.br/listaweb/Lista_imoveis_${uf}.csv`;
      const resp   = await fetch(csvUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Referer': 'https://venda-imoveis.caixa.gov.br/sistema/busca-imovel.asp',
        },
      });

      if (!resp.ok) {
        resultados[uf] = { erro: `HTTP ${resp.status}` };
        continue;
      }

      const buffer  = await resp.arrayBuffer();
      const decoder = new TextDecoder('iso-8859-1');
      const text    = decoder.decode(buffer);

      if (text.trim().startsWith('<!') || text.trim().startsWith('<html')) {
        resultados[uf] = { erro: 'Caixa retornou HTML (bloqueio)' };
        continue;
      }

      // Parsear CSV
      const imoveis = parseCSV(text, uf);
      console.log(`${uf}: ${imoveis.length} imóveis parseados`);

      if (imoveis.length === 0) {
        resultados[uf] = { erro: 'CSV vazio ou formato inválido' };
        continue;
      }

      // Deletar registros antigos do estado e inserir novos
      await supabase.from('imoveis').delete().eq('uf', uf);

      // Inserir em lotes de 200
      let salvos = 0;
      for (let i = 0; i < imoveis.length; i += 200) {
        const lote = imoveis.slice(i, i + 200);
        const { error } = await supabase.from('imoveis').insert(lote);
        if (error) { console.error('Erro insert:', error); break; }
        salvos += lote.length;
      }

      resultados[uf] = { salvos, total: imoveis.length };
      console.log(`${uf}: ${salvos} imóveis salvos`);

    } catch (e) {
      resultados[uf] = { erro: String(e) };
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    timestamp: new Date().toISOString(),
    resultados,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
});

function parseCSV(text: string, uf: string) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const sep     = lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
  const headers = splitLine(lines[0], sep).map(h => normalize(h));

  // Detectar índices de colunas
  const idx = {
    numero:    findCol(headers, ['numero','imovel','n']),
    endereco:  findCol(headers, ['enderec','logradouro']),
    bairro:    findCol(headers, ['bairro']),
    cidade:    findCol(headers, ['cidade','municipio']),
    preco:     findCol(headers, ['preco','valor']),
    aval:      findCol(headers, ['avalia']),
    desconto:  findCol(headers, ['desconto','desc']),
    descricao: findCol(headers, ['descric','tipo']),
    modalidade:findCol(headers, ['modalidade']),
    link:      findCol(headers, ['link','url','http']),
  };

  // Fallback layout fixo Caixa
  if (idx.endereco < 0) {
    idx.numero=0; idx.endereco=2; idx.bairro=3; idx.cidade=4;
    idx.preco=7;  idx.aval=8;    idx.desconto=9;
    idx.descricao=10; idx.modalidade=11; idx.link=12;
  }

  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i], sep);
    if (cols.length < 4) continue;

    const get = (k: keyof typeof idx) => (cols[idx[k]] || '').trim();

    const lance  = parseMoney(get('preco'));
    const aval   = parseMoney(get('aval'));
    if (lance === 0 && aval === 0) continue;

    const descStr  = parseFloat((get('desconto') || '0').replace(',', '.')) || 0;
    const desconto = descStr > 0 ? descStr : (aval > 0 && lance > 0 ? Math.round((1 - lance/aval)*100) : 0);

    const descricao  = get('descricao');
    const modalidade = get('modalidade');
    const tipo       = detectTipo(descricao + ' ' + get('endereco'));
    const financ     = descricao.toLowerCase().includes('financiamento') ? 'sim' : 'sim';
    const areaMatch  = descricao.match(/(\d+[,.]?\d*)\s*m[²2]/i);
    const area       = areaMatch ? areaMatch[1].replace(',','.') + 'm²' : '—';
    const dormsMatch = descricao.match(/(\d)\s*(quarto|dorm)/i);
    const dorms      = dormsMatch ? parseInt(dormsMatch[1]) : 0;

    result.push({
      numero: get('numero'), endereco: get('endereco'),
      bairro: get('bairro'), cidade: get('cidade'), uf,
      lance, aval, desconto, descricao, modalidade,
      link: get('link'), tipo, financ, area, dorms,
    });
  }
  return result;
}

function findCol(headers: string[], terms: string[]) {
  return headers.findIndex(h => terms.some(t => h.includes(t)));
}

function normalize(s: string) {
  return s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function splitLine(line: string, sep: string) {
  const result: string[] = [];
  let cur = '', inQuote = false;
  for (const c of line) {
    if (c === '"') inQuote = !inQuote;
    else if (c === sep && !inQuote) { result.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  result.push(cur.trim());
  return result;
}

function parseMoney(s: string) {
  s = s.replace(/[^\d,\.]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g,'').replace(',','.');
  else if (s.includes(',')) s = s.replace(',','.');
  return parseFloat(s) || 0;
}

function detectTipo(desc: string) {
  desc = desc.toLowerCase();
  if (desc.includes('apart') || desc.includes('apto')) return 'Apartamento';
  if (desc.includes('casa') || desc.includes('resid')) return 'Casa';
  if (desc.includes('terreno') || desc.includes('lote')) return 'Terreno';
  if (desc.includes('comercial') || desc.includes('sala') || desc.includes('loja') || desc.includes('galp')) return 'Comercial';
  if (desc.includes('rural') || desc.includes('chac') || desc.includes('sitio')) return 'Rural';
  return 'Imóvel';
}
