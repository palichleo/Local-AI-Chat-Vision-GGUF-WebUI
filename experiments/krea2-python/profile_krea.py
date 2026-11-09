"""Summarize one warmed diffusion step without retaining a large trace file."""


def summarize(profiler, sampled_step, wall_seconds):
    # CUDA annotations duplicate kernel records; use CPU ranges with attributed CUDA work.
    events = [e for e in profiler.key_averages() if str(e.device_type) == 'DeviceType.CPU']
    by_name = {e.key:e for e in events}
    categories = {}
    for event in events:
        if event.key.startswith('krea/') and event.key != 'krea/step':
            categories[event.key.removeprefix('krea/')] = {
                'calls':event.count,
                'cpu_total_seconds':round(event.cpu_time_total/1e6,6),
                'cuda_seconds':round(event.device_time_total/1e6,6)}
    attention = by_name.get('aten::scaled_dot_product_attention')
    attention_seconds = attention.device_time_total/1e6 if attention else 0
    categories['attention'] = {'calls':attention.count if attention else 0,'cuda_seconds':round(attention_seconds,6)}
    total = by_name['krea/step'].device_time_total/1e6
    attributed = sum(item['cuda_seconds'] for item in categories.values())
    if total <= 0 or attributed > total+1e-4:
        raise RuntimeError('Missing CUDA attribution or overlapping profile categories')
    categories['other'] = {'cuda_seconds':round(total-attributed,6)}
    top = sorted((e for e in events if not e.key.startswith('krea/')),key=lambda e:e.self_device_time_total,reverse=True)[:15]
    return {'sampled_step':sampled_step,'sample_wall_seconds':round(wall_seconds,6),
            'cuda_work_seconds':round(total,6),'categories':categories,
            'top_operators':[{'name':e.key,'calls':e.count,'self_cuda_seconds':round(e.self_device_time_total/1e6,6)} for e in top],
            'note':'CPU ranges include blocking waits and overlap CUDA work: do not add CPU and CUDA totals. CUDA times sum attributed operations, not utilization. Profiler start/stop and analysis overhead are excluded from the sampled interval.'}
