export interface PortugueseAiEvaluationCase {
  id: string;
  text: string;
  explicitTask: boolean;
}

export interface AiEvaluationPrediction {
  caseId: string;
  predictedTask: boolean;
}

export interface AiEvaluationMetrics {
  explicitTaskRecall: number;
  falsePositiveRate: number;
  truePositives: number;
  explicitTasks: number;
  falsePositives: number;
  nonTasks: number;
  passed: boolean;
}

export function scoreAiEvaluation(
  corpus: readonly PortugueseAiEvaluationCase[],
  predictions: readonly AiEvaluationPrediction[],
  targets = { minimumExplicitTaskRecall: 0.9, maximumFalsePositiveRate: 0.1 },
): AiEvaluationMetrics {
  const predictionById = new Map(predictions.map((prediction) => [prediction.caseId, prediction]));
  const explicitTasks = corpus.filter((item) => item.explicitTask);
  const nonTasks = corpus.filter((item) => !item.explicitTask);
  const missing = corpus.filter((item) => !predictionById.has(item.id));
  if (missing.length > 0) {
    throw new Error(`Missing predictions for: ${missing.map((item) => item.id).join(", ")}`);
  }

  const truePositives = explicitTasks.filter(
    (item) => predictionById.get(item.id)?.predictedTask === true,
  ).length;
  const falsePositives = nonTasks.filter(
    (item) => predictionById.get(item.id)?.predictedTask === true,
  ).length;
  const explicitTaskRecall = explicitTasks.length === 0 ? 1 : truePositives / explicitTasks.length;
  const falsePositiveRate = nonTasks.length === 0 ? 0 : falsePositives / nonTasks.length;

  return {
    explicitTaskRecall,
    falsePositiveRate,
    truePositives,
    explicitTasks: explicitTasks.length,
    falsePositives,
    nonTasks: nonTasks.length,
    passed:
      explicitTaskRecall >= targets.minimumExplicitTaskRecall &&
      falsePositiveRate <= targets.maximumFalsePositiveRate,
  };
}

/** A small offline smoke baseline; production decisions always use DeepSeek. */
export function conservativePortugueseTaskHeuristic(text: string): boolean {
  const normalized = text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  if (
    /\b(nao precisa|nao faca|ignore|cancele o pedido|ja (enviei|liguei|respondi|conclui|atualizei)|foi (enviado|concluido|atualizado))\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return /\b(por favor|preciso que|nao esqueca|ficou combinado|voce pode|consegue|tem que|trello:|envie|manda|mande|marque|agende|faca|crie|verifique|confirme|atualize|prepare|ligue|retorne|reserve|finalize|suba|corrija|anexe|emita|protocole|compre|organize|revise|adicione|remova|compare|abra|responda|despache|lembre|fale|cobre|separe|reabra|inclua|avise|acompanhe|liste|reagende|peca|mova|documente)\b/.test(
    normalized,
  );
}

export const PORTUGUESE_AI_EVALUATION_CORPUS: readonly PortugueseAiEvaluationCase[] = [
  { id: "task-01", text: "Por favor, envie o orçamento revisado até amanhã.", explicitTask: true },
  { id: "task-02", text: "Preciso que você confirme a reunião com a Ana.", explicitTask: true },
  { id: "task-03", text: "Consegue marcar a vistoria para sexta-feira?", explicitTask: true },
  { id: "task-04", text: "Não esqueça de ligar para o fornecedor às 14h.", explicitTask: true },
  { id: "task-05", text: "Ficou combinado que você atualiza a planilha hoje.", explicitTask: true },
  { id: "task-06", text: "Você pode preparar a minuta do contrato?", explicitTask: true },
  { id: "task-07", text: "Até amanhã faça a conferência das notas fiscais.", explicitTask: true },
  { id: "task-08", text: "Tem que anexar o comprovante no processo.", explicitTask: true },
  { id: "task-09", text: "trello: criar card para renovar o certificado digital", explicitTask: true },
  { id: "task-10", text: "Agende uma conversa com o contador na próxima semana.", explicitTask: true },
  { id: "task-11", text: "Verifique se o pagamento entrou na conta.", explicitTask: true },
  { id: "task-12", text: "Me mande as fotos da obra até as 18h.", explicitTask: true },
  { id: "task-13", text: "Confirme o prazo de entrega com a transportadora.", explicitTask: true },
  { id: "task-14", text: "Atualize o card quando o cliente responder.", explicitTask: true },
  { id: "task-15", text: "Prepare o relatório mensal para segunda-feira.", explicitTask: true },
  { id: "task-16", text: "Ligue para o João e peça os documentos faltantes.", explicitTask: true },
  { id: "task-17", text: "Retorne para a cliente ainda hoje.", explicitTask: true },
  { id: "task-18", text: "Reserve a sala de reuniões para 9h.", explicitTask: true },
  { id: "task-19", text: "Finalize a apresentação antes da reunião.", explicitTask: true },
  { id: "task-20", text: "Suba a versão corrigida no Drive.", explicitTask: true },
  { id: "task-21", text: "Corrija o endereço no cadastro do cliente.", explicitTask: true },
  { id: "task-22", text: "Anexe a ART no protocolo 123.", explicitTask: true },
  { id: "task-23", text: "Emita a nota fiscal do serviço concluído.", explicitTask: true },
  { id: "task-24", text: "Protocole a defesa até o dia 20.", explicitTask: true },
  { id: "task-25", text: "Compre os materiais que faltam para a instalação.", explicitTask: true },
  { id: "task-26", text: "Organize os arquivos por cliente.", explicitTask: true },
  { id: "task-27", text: "Revise o texto antes de enviar.", explicitTask: true },
  { id: "task-28", text: "Envie os dados bancários para o financeiro.", explicitTask: true },
  { id: "task-29", text: "Adicione a Maria como responsável pelo card.", explicitTask: true },
  { id: "task-30", text: "Remova a etiqueta urgente depois da aprovação.", explicitTask: true },
  { id: "task-31", text: "Compare as duas propostas e me diga qual é melhor.", explicitTask: true },
  { id: "task-32", text: "Faça o backup do banco antes da atualização.", explicitTask: true },
  { id: "task-33", text: "Abra um chamado para corrigir o acesso.", explicitTask: true },
  { id: "task-34", text: "Responda ao e-mail do jurídico hoje.", explicitTask: true },
  { id: "task-35", text: "Despache os documentos para Cuiabá amanhã cedo.", explicitTask: true },
  { id: "none-01", text: "Bom dia! Tudo bem?", explicitTask: false },
  { id: "none-02", text: "Obrigado pela ajuda.", explicitTask: false },
  { id: "none-03", text: "Como está o tempo aí?", explicitTask: false },
  { id: "none-04", text: "Já enviei o orçamento ontem.", explicitTask: false },
  { id: "none-05", text: "O relatório foi enviado para o cliente.", explicitTask: false },
  { id: "none-06", text: "Talvez a reunião seja na sexta.", explicitTask: false },
  { id: "none-07", text: "Eu gosto mais da primeira opção.", explicitTask: false },
  { id: "none-08", text: "Choveu bastante durante a vistoria.", explicitTask: false },
  { id: "none-09", text: "Pode ser.", explicitTask: false },
  { id: "none-10", text: "Estou em reunião agora.", explicitTask: false },
  { id: "none-11", text: "Não precisa enviar outra cópia.", explicitTask: false },
  { id: "none-12", text: "Já liguei para o fornecedor.", explicitTask: false },
  { id: "none-13", text: "Quando o relatório chega?", explicitTask: false },
  { id: "none-14", text: "Parabéns pelo trabalho!", explicitTask: false },
  { id: "none-15", text: "O cliente disse que receberia o material.", explicitTask: false },
  { id: "none-16", text: "Foi decidido manter o contrato atual.", explicitTask: false },
  { id: "none-17", text: "A reunião terminou às 11h.", explicitTask: false },
  { id: "none-18", text: "Segue o documento para conhecimento.", explicitTask: false },
  { id: "none-19", text: "Você enviou a proposta?", explicitTask: false },
  { id: "none-20", text: "Não faça nenhuma alteração agora.", explicitTask: false },
  { id: "none-21", text: "Ignore o pedido anterior.", explicitTask: false },
  { id: "none-22", text: "O preço ficou em mil reais.", explicitTask: false },
  { id: "none-23", text: "Talvez amanhã eu veja isso.", explicitTask: false },
  { id: "none-24", text: "Estou aguardando uma resposta.", explicitTask: false },
  { id: "none-25", text: "O card já foi concluído.", explicitTask: false },
  { id: "task-36", text: "Me lembre de revisar o contrato amanhã às 9h.", explicitTask: true },
  { id: "task-37", text: "Fale com a Paula sobre a vistoria até quarta.", explicitTask: true },
  { id: "task-38", text: "Crie um checklist para a entrega do projeto.", explicitTask: true },
  { id: "task-39", text: "Assim que o cliente responder, atualize o prazo.", explicitTask: true },
  { id: "task-40", text: "Cobre o retorno do laboratório na segunda.", explicitTask: true },
  { id: "task-41", text: "Separe os documentos do processo 456.", explicitTask: true },
  { id: "task-42", text: "Reabra a tarefa de conferência cadastral.", explicitTask: true },
  { id: "task-43", text: "Inclua os custos de transporte no orçamento.", explicitTask: true },
  { id: "task-44", text: "Avise quando faltar duas horas para a reunião.", explicitTask: true },
  { id: "task-45", text: "Acompanhe a resposta da prefeitura.", explicitTask: true },
  { id: "task-46", text: "Atualize a prioridade para urgente.", explicitTask: true },
  { id: "task-47", text: "Liste as pendências da implantação.", explicitTask: true },
  { id: "task-48", text: "Faça follow-up com o comprador em três dias.", explicitTask: true },
  { id: "task-49", text: "Registre a decisão tomada na reunião.", explicitTask: true },
  { id: "task-50", text: "Reagende a visita para amanhã às 15h.", explicitTask: true },
  { id: "task-51", text: "Me lembre toda sexta de enviar o resumo.", explicitTask: true },
  { id: "task-52", text: "Confirme com o engenheiro quem assinará a ART.", explicitTask: true },
  { id: "task-53", text: "Acompanhe esse pagamento até cair.", explicitTask: true },
  { id: "task-54", text: "Adicione uma etapa de revisão jurídica.", explicitTask: true },
  { id: "task-55", text: "Mova o cartão para em andamento.", explicitTask: true },
  { id: "task-56", text: "Prepare os anexos antes do protocolo.", explicitTask: true },
  { id: "task-57", text: "Verifique o vencimento do certificado.", explicitTask: true },
  { id: "task-58", text: "Peça ao financeiro o comprovante hoje.", explicitTask: true },
  { id: "task-59", text: "Documente o procedimento de conferência.", explicitTask: true },
  { id: "task-60", text: "Lembre de cobrar a devolução do contrato.", explicitTask: true },
  { id: "none-26", text: "O orçamento ficou pronto hoje cedo.", explicitTask: false },
  { id: "none-27", text: "Acho que a segunda opção é melhor.", explicitTask: false },
  { id: "none-28", text: "O cliente ainda não respondeu.", explicitTask: false },
  { id: "none-29", text: "Vou sair para o almoço agora.", explicitTask: false },
  { id: "none-30", text: "A visita de ontem foi tranquila.", explicitTask: false },
  { id: "none-31", text: "Não tenho certeza sobre esse prazo.", explicitTask: false },
  { id: "none-32", text: "O documento parece correto.", explicitTask: false },
  { id: "none-33", text: "A Paula comentou sobre o projeto.", explicitTask: false },
  { id: "none-34", text: "Esse assunto pode esperar.", explicitTask: false },
  { id: "none-35", text: "Recebi sua mensagem.", explicitTask: false },
  { id: "none-36", text: "A reunião foi reagendada para terça.", explicitTask: false },
  { id: "none-37", text: "Não precisa me lembrar disso.", explicitTask: false },
  { id: "none-38", text: "O pagamento ainda está em análise.", explicitTask: false },
  { id: "none-39", text: "Depois conversamos sobre isso.", explicitTask: false },
  { id: "none-40", text: "Já concluí a conferência ontem.", explicitTask: false },
] as const;
