export type AudioQuality = 'standard' | 'higher' | 'exhigh' | 'lossless' | 'hires' | 'jyeffect' | 'jymaster' | 'dolby' | 'sky';
export type OutputFormat = 'mp3' | 'flac' | 'wav' | 'opus' | 'aac' | 'm4a' | 'copy';

export const AUDIO_QUALITIES: { level: AudioQuality; name: string }[] = [
    { level: 'standard', name: '标准 (128k)' },
    { level: 'higher', name: '较高 (320k)' },
    { level: 'exhigh', name: '极高 (320k)' },
    { level: 'lossless', name: '无损 (FLAC)' },
    { level: 'hires', name: 'Hi-Res' },
    { level: 'jyeffect', name: '高清环绕声' },
    { level: 'jymaster', name: '超清母带' },
    { level: 'dolby', name: '杜比全景声' },
    { level: 'sky', name: '沉浸环绕声' },
];

export const OUTPUT_FORMATS: { format: OutputFormat; name: string; ext: string; desc: string }[] = [
    { format: 'copy', name: '原始格式', ext: '', desc: '直接复制源文件，不做转码' },
    { format: 'mp3', name: 'MP3', ext: '.mp3', desc: '通用兼容，有损压缩' },
    { format: 'flac', name: 'FLAC', ext: '.flac', desc: '无损压缩，体积较小' },
    { format: 'wav', name: 'WAV', ext: '.wav', desc: '无损无压缩，体积最大' },
    { format: 'opus', name: 'Opus', ext: '.opus', desc: '高效有损，低码率高质' },
    { format: 'aac', name: 'AAC', ext: '.aac', desc: '高效有损，苹果友好' },
    { format: 'm4a', name: 'M4A', ext: '.m4a', desc: 'AAC 封装，苹果友好' },
];
